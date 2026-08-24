//
//  superlog_viewer - the native viewer.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  Structured rows with level/topic colouring, min-level + stream +
//  substring filters, follow, copy (whole filtered view or one row) and
//  json/csv/txt export - the React viewer (viewer/react/src/) is the
//  behavioural spec and this tracks it. The shape:
//
//    - Feed thread: a snicholls::event_loop runs a websocket_client against
//      ws://host:7333/ws?topic=* with the library's own reconnect/backoff.
//      Envelope frames are parsed to rows there (nlohmann::json, pinned in
//      third_party/); rows land in a mutex-guarded deque and nothing
//      UI-side touches the network.
//    - UI thread: GLFW + Dear ImGui at vsync. Once per frame the deque is
//      drained into a capped ring, then rendered through ImGuiListClipper -
//      only visible rows pay layout, so 100k rows scroll flat.
//    - Rows keep the raw event line, not a parsed tree: exports re-parse on
//      demand (rare) instead of every row carrying a json object (100k of
//      them is real memory). Copy and export act on the *visible* rows -
//      export follows the filters, because the moment someone reaches for
//      it they have already narrowed the view to the thing they are chasing.
//

#include "event/loop.hpp"
#include "http/websocket_client.hpp"

#include <nlohmann/json.hpp>

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <GLFW/glfw3.h>

#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <unistd.h>

namespace {

constexpr std::size_t max_rows = 100000;

constexpr const char* levels[] = {"TRACE", "DEBUG", "INFO",
                                  "WARN",  "ERROR", "CRITICAL"};

// Same palette as the React viewer, so the two screens agree on what a
// stream and a level look like.
inline ImVec4 level_color(int idx)
{
    switch (idx) {
    case 0:  return {0.36f, 0.39f, 0.44f, 1};   // TRACE  #5c6470
    case 1:  return {0.31f, 0.71f, 0.79f, 1};   // DEBUG  #4fb6c9
    case 2:  return {0.41f, 0.79f, 0.39f, 1};   // INFO   #68c964
    case 3:  return {0.85f, 0.64f, 0.25f, 1};   // WARN   #d9a441
    case 4:  return {0.88f, 0.36f, 0.31f, 1};   // ERROR  #e05b4f
    case 5:  return {1.00f, 0.18f, 0.12f, 1};   // CRITICAL #ff2e1f
    default: return {0.84f, 0.85f, 0.89f, 1};
    }
}

inline ImVec4 topic_color(const std::string& topic)
{
    static const ImVec4 palette[] = {
        {0.48f, 0.64f, 0.97f, 1}, {0.73f, 0.60f, 0.97f, 1},
        {0.88f, 0.69f, 0.41f, 1}, {0.62f, 0.81f, 0.42f, 1},
        {0.97f, 0.46f, 0.56f, 1}, {0.16f, 0.76f, 0.87f, 1},
    };
    unsigned h = 0;
    for (const char c : topic)
        h = h * 31u + static_cast<unsigned char>(c);
    return palette[h % 6];
}

inline int level_index(const std::string& level)
{
    for (int i = 0; i < 6; ++i)
        if (level == levels[i])
            return i;
    return 2;                                   // tolerant-reader default: INFO
}

struct row {
    std::string topic, time, tag, msg, extra;   // extra: " =metric k=v (src)"
    std::string raw;                            // the event line, verbatim
    std::uint64_t hub_seq = 0;
    int level = 2;
    bool multiline = false;                     // a field was collapsed for display
};

struct feed {
    std::mutex m;
    std::deque<row> rows;                       // parsed on the feed thread
    std::uint64_t received = 0;
    bool connected = false;
};

// One event line -> one row, tolerant-reader rule applied: a line that is
// not JSON becomes a plain INFO row carrying the line as msg.
row parse_row(std::string line, const std::string& topic, std::uint64_t hub_seq)
{
    row r;
    r.topic = topic;
    r.hub_seq = hub_seq;
    const auto j = nlohmann::json::parse(line, nullptr, /*allow_exceptions=*/false);
    if (j.is_discarded() || !j.is_object()) {
        r.msg = line;
        r.raw = std::move(line);
        return r;
    }
    r.raw = std::move(line);
    r.msg = j.contains("msg") && j["msg"].is_string() ? j["msg"].get<std::string>() : r.raw;
    if (j.contains("ts") && j["ts"].is_string()) {
        const auto ts = j["ts"].get<std::string>();
        if (ts.size() >= 23)
            r.time = ts.substr(11, 12);         // HH:MM:SS.mmm
    }
    if (j.contains("tag") && j["tag"].is_string())
        r.tag = j["tag"].get<std::string>();
    if (j.contains("level") && j["level"].is_string())
        r.level = level_index(j["level"].get<std::string>());
    if (j.contains("metric") && j["metric"].is_object() && j["metric"].contains("value"))
        r.extra += " =" + j["metric"]["value"].dump();
    if (j.contains("fields") && j["fields"].is_object())
        for (const auto& [k, v] : j["fields"].items()) {
            std::string val = v.is_string() ? v.get<std::string>() : v.dump();
            // A stack or a locals dump is many lines; inline it and one
            // event becomes ten rows, which is the wall of text this view
            // exists to replace. Keep the first line, mark it truncated -
            // the full value is still in the export and the journal.
            const std::size_t nl = val.find('\n');
            if (nl != std::string::npos) {
                val = val.substr(0, nl) + " …";
                r.multiline = true;
            }
            if (val.size() > 160)
                val = val.substr(0, 160) + " …";
            r.extra += ' ' + k + '=' + val;
        }
    if (j.contains("src") && j["src"].is_string())
        r.extra += " (" + j["src"].get<std::string>() + ')';
    return r;
}

// The human-readable line - what the screen shows, minus the colour. The
// React viewer's rowText() is the same shape; keep them agreeing.
std::string row_text(const row& r)
{
    std::string s = r.time.empty() ? "-" : r.time;
    s += ' ';
    s += r.topic;
    s += ' ';
    s += levels[r.level];
    if (!r.tag.empty())
        s += " [" + r.tag + ']';
    s += ' ' + r.msg + r.extra;
    return s;
}

// ---- export ----------------------------------------------------------

std::string csv_field(const std::string& raw)
{
    // Log content is untrusted; a msg starting with = + - @ would execute
    // as a formula when the CSV lands in a spreadsheet. Apostrophe-prefix
    // is the standard defusal - same rule as the React viewer's csvField.
    std::string v = raw;
    if (!v.empty() && (v[0] == '=' || v[0] == '+' || v[0] == '-' || v[0] == '@' ||
                       v[0] == '\t' || v[0] == '\r'))
        v.insert(v.begin(), '\'');
    if (v.find_first_of(",\"\n\r") == std::string::npos)
        return v;
    std::string out = "\"";
    for (const char c : v) {
        if (c == '"')
            out += '"';
        out += c;
    }
    out += '"';
    return out;
}

// Same column order as the React viewer's toCsv().
std::string to_csv(const std::vector<const row*>& rows)
{
    std::string out = "hub_seq,ts,topic,level,tag,msg,fields,metric_name,metric_value,src,session,seq\n";
    for (const row* r : rows) {
        const auto j = nlohmann::json::parse(r->raw, nullptr, false);
        const bool ok = !j.is_discarded() && j.is_object();
        auto str = [&](const char* k) {
            return ok && j.contains(k) && j[k].is_string() ? j[k].get<std::string>() : std::string();
        };
        auto num = [&](const char* k) {
            return ok && j.contains(k) && j[k].is_number() ? j[k].dump() : std::string();
        };
        std::string fields, mname, mvalue;
        if (ok && j.contains("fields"))
            fields = j["fields"].dump();
        if (ok && j.contains("metric") && j["metric"].is_object()) {
            if (j["metric"].contains("name") && j["metric"]["name"].is_string())
                mname = j["metric"]["name"].get<std::string>();
            if (j["metric"].contains("value"))
                mvalue = j["metric"]["value"].dump();
        }
        out += std::to_string(r->hub_seq) + ',' + csv_field(str("ts")) + ',' +
               csv_field(r->topic) + ',' + levels[r->level] + ',' +
               csv_field(r->tag) + ',' + csv_field(r->msg) + ',' +
               csv_field(fields) + ',' + csv_field(mname) + ',' + mvalue + ',' +
               csv_field(str("src")) + ',' + csv_field(str("session")) + ',' +
               num("seq") + '\n';
    }
    return out;
}

// A JSON array of {topic, hub_seq, event} - the event verbatim when it was
// JSON, tolerant-wrapped when it was not.
std::string to_json(const std::vector<const row*>& rows)
{
    nlohmann::json arr = nlohmann::json::array();
    for (const row* r : rows) {
        auto ev = nlohmann::json::parse(r->raw, nullptr, false);
        if (ev.is_discarded() || !ev.is_object())
            ev = nlohmann::json{{"msg", r->raw}};
        arr.push_back({{"topic", r->topic}, {"hub_seq", r->hub_seq}, {"event", std::move(ev)}});
    }
    return arr.dump(2) + '\n';
}

std::string to_txt(const std::vector<const row*>& rows)
{
    std::string out;
    for (const row* r : rows) {
        out += row_text(*r);
        out += '\n';
    }
    return out;
}

// ~/Downloads when it exists (this is a Mac/desktop dev tool), else cwd.
std::string export_path(const char* ext)
{
    std::string dir = ".";
    if (const char* home = std::getenv("HOME")) {
        const std::string dl = std::string(home) + "/Downloads";
        if (::access(dl.c_str(), W_OK) == 0)
            dir = dl;
    }
    char stamp[32];
    const std::time_t t = std::time(nullptr);
    std::strftime(stamp, sizeof stamp, "%Y%m%d-%H%M%S", std::localtime(&t));
    return dir + "/superlog-" + stamp + '.' + ext;
}

bool write_file(const std::string& path, const std::string& text)
{
    std::FILE* f = std::fopen(path.c_str(), "wb");
    if (!f)
        return false;
    const bool ok = std::fwrite(text.data(), 1, text.size(), f) == text.size();
    return std::fclose(f) == 0 && ok;
}

} // namespace

int main()
{
    const char* env = std::getenv("SUPER_LOG_URL");
    const std::string url = std::string(env ? env : "ws://127.0.0.1:7333") + "/ws?topic=*";

    // ---- feed thread: all networking lives here
    feed fd;
    snicholls::event_loop loop;
    snicholls::http::websocket_client ws;   // auto-reconnect + jittered backoff built in
    ws.on_open([&fd] {
        std::lock_guard<std::mutex> g(fd.m);
        fd.connected = true;
    });
    ws.on_close([&fd](snicholls::http::ws_client_status) {
        std::lock_guard<std::mutex> g(fd.m);
        fd.connected = false;
    });
    ws.on_message([&fd](const snicholls::http::ws_message& m) {
        // One envelope frame may carry a whole NDJSON chunk: one row per line
        const auto env_j = nlohmann::json::parse(m.data, nullptr, false);
        if (env_j.is_discarded() || !env_j.is_object() || !env_j.contains("payload"))
            return;                             // not an envelope frame
        const std::string topic =
            env_j.contains("topic") && env_j["topic"].is_string()
                ? env_j["topic"].get<std::string>() : std::string();
        const std::uint64_t hub_seq =
            env_j.contains("seq") && env_j["seq"].is_number_unsigned()
                ? env_j["seq"].get<std::uint64_t>() : 0;
        const std::string payload =
            env_j["payload"].is_string() ? env_j["payload"].get<std::string>() : std::string();
        std::lock_guard<std::mutex> g(fd.m);
        std::size_t from = 0;
        for (std::size_t nl; (nl = payload.find('\n', from)) != std::string::npos; from = nl + 1)
            if (nl > from)
                fd.rows.push_back(parse_row(payload.substr(from, nl - from), topic, hub_seq));
        if (from < payload.size())
            fd.rows.push_back(parse_row(payload.substr(from), topic, hub_seq));
        ++fd.received;
        while (fd.rows.size() > max_rows)
            fd.rows.pop_front();
    });
    if (!ws.connect(loop, url)) {
        std::fprintf(stderr, "superlog_viewer: bad url %s\n", url.c_str());
        return 1;
    }
    std::thread net([&loop] { loop.run(); });

    // ---- UI thread: GLFW + ImGui boilerplate, then the one window
    if (!glfwInit())
        return 1;
    glfwWindowHint(GLFW_CONTEXT_VERSION_MAJOR, 3);
    glfwWindowHint(GLFW_CONTEXT_VERSION_MINOR, 2);
    glfwWindowHint(GLFW_OPENGL_PROFILE, GLFW_OPENGL_CORE_PROFILE);
    glfwWindowHint(GLFW_OPENGL_FORWARD_COMPAT, GL_TRUE);
    GLFWwindow* win = glfwCreateWindow(1280, 800, "super-log", nullptr, nullptr);
    if (!win)
        return 1;
    glfwMakeContextCurrent(win);
    glfwSwapInterval(1);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGui::StyleColorsDark();
    ImGui_ImplGlfw_InitForOpenGL(win, true);
    ImGui_ImplOpenGL3_Init("#version 150");

    std::vector<row> rows;
    std::vector<std::string> topics;            // sorted, for the stream combo
    char filter[256] = "";
    int min_level = 0;
    int topic_sel = 0;                          // 0 = all streams
    bool follow = true;
    // Pause freezes the DISPLAY, not the collection: rows keep accumulating
    // and only the first frozen_count render. A watermark, not a copy -
    // 100k rows are not worth duplicating to stand still.
    bool paused = false;
    std::size_t frozen_count = 0;
    double copied_until = 0;                    // transient button/status text
    double status_until = 0;
    std::string status;

    while (!glfwWindowShouldClose(win)) {
        glfwPollEvents();

        bool connected;
        {
            std::lock_guard<std::mutex> g(fd.m);
            connected = fd.connected;
            while (!fd.rows.empty()) {
                const std::string& t = fd.rows.front().topic;
                const auto at = std::lower_bound(topics.begin(), topics.end(), t);
                if (at == topics.end() || *at != t)
                    topics.insert(at, t);
                rows.push_back(std::move(fd.rows.front()));
                fd.rows.pop_front();
            }
        }
        if (rows.size() > max_rows) {
            const std::size_t drop = rows.size() - max_rows;
            rows.erase(rows.begin(), rows.begin() + static_cast<std::ptrdiff_t>(drop));
            // The ring slid under the paused view; keep the watermark honest
            frozen_count = frozen_count > drop ? frozen_count - drop : 0;
        }

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        const ImGuiViewport* vp = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(vp->WorkPos);
        ImGui::SetNextWindowSize(vp->WorkSize);
        ImGui::Begin("super-log", nullptr,
                     ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove);

        // Filter first, so copy/export see exactly what the table shows
        const std::string needle = filter;
        const std::string* want_topic =
            topic_sel > 0 ? &topics[static_cast<std::size_t>(topic_sel - 1)] : nullptr;
        std::vector<const row*> shown;
        shown.reserve(rows.size());
        const std::size_t shown_limit = paused ? std::min(frozen_count, rows.size()) : rows.size();
        for (std::size_t i = 0; i < shown_limit; ++i) {
            const row& r = rows[i];
            if (r.level < min_level)
                continue;
            if (want_topic && r.topic != *want_topic)
                continue;
            if (!needle.empty() && r.msg.find(needle) == std::string::npos &&
                r.extra.find(needle) == std::string::npos &&
                r.tag.find(needle) == std::string::npos &&
                r.topic.find(needle) == std::string::npos)
                continue;
            shown.push_back(&r);
        }

        ImGui::TextColored(connected ? ImVec4(0.4f, 0.8f, 0.4f, 1)
                                     : ImVec4(0.9f, 0.4f, 0.3f, 1),
                           connected ? "live" : "reconnecting...");
        ImGui::SameLine();
        if (ImGui::Button(paused ? "play" : "pause")) {
            if (!paused)
                frozen_count = rows.size();
            paused = !paused;
        }
        if (paused) {
            ImGui::SameLine();
            ImGui::TextDisabled("paused");
        }
        ImGui::SameLine();
        ImGui::SetNextItemWidth(110);
        ImGui::Combo("##minlevel", &min_level,
                     "\xE2\x89\xA5 TRACE\0\xE2\x89\xA5 DEBUG\0\xE2\x89\xA5 INFO\0"
                     "\xE2\x89\xA5 WARN\0\xE2\x89\xA5 ERROR\0\xE2\x89\xA5 CRITICAL\0");
        ImGui::SameLine();
        {
            std::string items = "all streams";
            items += '\0';
            for (const auto& t : topics) {
                items += t;
                items += '\0';
            }
            if (topic_sel > static_cast<int>(topics.size()))
                topic_sel = 0;
            ImGui::SetNextItemWidth(180);
            ImGui::Combo("##topic", &topic_sel, items.c_str());
        }
        ImGui::SameLine();
        ImGui::Checkbox("follow", &follow);
        ImGui::SameLine();
        if (ImGui::Button("clear"))
            rows.clear();
        ImGui::SameLine();
        if (ImGui::Button(ImGui::GetTime() < copied_until ? "copied" : "copy")) {
            ImGui::SetClipboardText(to_txt(shown).c_str());
            copied_until = ImGui::GetTime() + 1.2;
        }
        ImGui::SameLine();
        ImGui::TextDisabled("export");
        const struct {
            const char* label;
            std::string (*serialise)(const std::vector<const row*>&);
        } exports[] = {{"json", to_json}, {"csv", to_csv}, {"txt", to_txt}};
        for (const auto& e : exports) {
            ImGui::SameLine();
            if (ImGui::Button(e.label)) {
                const std::string path = export_path(e.label);
                status = write_file(path, e.serialise(shown))
                             ? "wrote " + path
                             : "cannot write " + path;
                status_until = ImGui::GetTime() + 5.0;
            }
        }
        ImGui::SameLine();
        ImGui::Text("%zu/%zu", shown.size(), rows.size());
        if (ImGui::GetTime() < status_until) {
            ImGui::SameLine();
            ImGui::TextDisabled("%s", status.c_str());
        }
        ImGui::SameLine();
        ImGui::SetNextItemWidth(-1);
        ImGui::InputTextWithHint("##filter", "filter...", filter, sizeof filter);

        if (ImGui::BeginTable("rows", 5,
                              ImGuiTableFlags_ScrollY | ImGuiTableFlags_RowBg |
                                  ImGuiTableFlags_SizingFixedFit)) {
            ImGui::TableSetupColumn("##copy", ImGuiTableColumnFlags_WidthFixed, 36.0f);
            ImGui::TableSetupColumn("time", ImGuiTableColumnFlags_WidthFixed, 100.0f);
            ImGui::TableSetupColumn("stream", ImGuiTableColumnFlags_WidthFixed, 150.0f);
            ImGui::TableSetupColumn("level", ImGuiTableColumnFlags_WidthFixed, 70.0f);
            ImGui::TableSetupColumn("message", ImGuiTableColumnFlags_WidthStretch);
            ImGuiListClipper clip;
            clip.Begin(static_cast<int>(shown.size()));
            while (clip.Step()) {
                for (int i = clip.DisplayStart; i < clip.DisplayEnd; ++i) {
                    const row& r = *shown[static_cast<std::size_t>(i)];
                    ImGui::PushID(i);
                    ImGui::TableNextRow();
                    ImGui::TableNextColumn();
                    if (ImGui::SmallButton("copy"))
                        ImGui::SetClipboardText((row_text(r) + '\n').c_str());
                    ImGui::TableNextColumn();
                    ImGui::TextColored({0.36f, 0.39f, 0.44f, 1}, "%s", r.time.c_str());
                    ImGui::TableNextColumn();
                    ImGui::TextColored(topic_color(r.topic), "%s", r.topic.c_str());
                    ImGui::TableNextColumn();
                    ImGui::TextColored(level_color(r.level), "%s", levels[r.level]);
                    ImGui::TableNextColumn();
                    if (!r.tag.empty()) {
                        ImGui::TextColored({0.54f, 0.58f, 0.64f, 1}, "[%s]", r.tag.c_str());
                        ImGui::SameLine();
                    }
                    ImGui::TextUnformatted(r.msg.c_str());
                    if (!r.extra.empty()) {
                        ImGui::SameLine();
                        ImGui::TextColored({0.54f, 0.58f, 0.64f, 1}, "%s", r.extra.c_str());
                    }
                    ImGui::PopID();
                }
            }
            if (follow && !paused && ImGui::GetScrollY() >= ImGui::GetScrollMaxY() - 1)
                ImGui::SetScrollHereY(1.0f);
            ImGui::EndTable();
        }
        ImGui::End();

        ImGui::Render();
        int w, h;
        glfwGetFramebufferSize(win, &w, &h);
        glViewport(0, 0, w, h);
        glClearColor(0.06f, 0.07f, 0.09f, 1.0f);
        glClear(GL_COLOR_BUFFER_BIT);
        ImGui_ImplOpenGL3_RenderDrawData(ImGui::GetDrawData());
        glfwSwapBuffers(win);
    }

    ws.close();
    loop.stop();
    net.join();
    ImGui_ImplOpenGL3_Shutdown();
    ImGui_ImplGlfw_Shutdown();
    ImGui::DestroyContext();
    glfwDestroyWindow(win);
    glfwTerminate();
    return 0;
}
