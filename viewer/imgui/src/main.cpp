//
//  superlog_viewer - the native viewer.
//
//  Copyright 2026 Saxon Herschel Nicholls
//
//  STATUS: skeleton (HANDOFF.md, M3). The shape is decided; the pixels are
//  not. What is decided:
//
//    - Feed thread: a snicholls::event_loop runs a websocket_client against
//      ws://host:7333/ws?topic=* with the library's own reconnect/backoff.
//      Frames land in a mutex-guarded deque; nothing UI-side touches the
//      network.
//    - UI thread: GLFW + Dear ImGui at vsync. Once per frame the deque is
//      drained into a capped ring, then rendered through ImGuiListClipper -
//      only visible rows pay layout, so 100k rows scroll flat.
//    - Parsing: extract_string_field() below is a placeholder that pulls
//      "payload" out of the hub envelope. M3 replaces it with a real little
//      JSON reader (see the note there) and per-event rows with level/topic
//      colouring like viewer/react - which is the spec to match.
//

#include "event/loop.hpp"
#include "http/websocket_client.hpp"

#include <imgui.h>
#include <imgui_impl_glfw.h>
#include <imgui_impl_opengl3.h>
#include <GLFW/glfw3.h>

#include <cstdio>
#include <cstdlib>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace {

constexpr std::size_t max_rows = 100000;

struct feed {
    std::mutex m;
    std::deque<std::string> lines;          // raw payload chunks, newest at back
    std::uint64_t received = 0;
    bool connected = false;
};

// Placeholder envelope parsing: good enough for {"seq":..,"payload":".."}
// frames the hub emits, which never nest objects inside strings except via
// escapes. M3: replace with a ~100 line recursive-descent JSON reader in the
// SDK (ts-moveables' utils/json.hpp escapes but does not parse), and parse
// the payload's NDJSON lines into structured rows.
std::string extract_string_field(const std::string& json, const std::string& key)
{
    const std::string needle = "\"" + key + "\":\"";
    const std::size_t at = json.find(needle);
    if (at == std::string::npos)
        return {};
    std::string out;
    for (std::size_t i = at + needle.size(); i < json.size(); ++i) {
        const char c = json[i];
        if (c == '\\' && i + 1 < json.size()) {
            const char n = json[++i];
            out += (n == 'n') ? '\n' : (n == 't') ? '\t' : n;
        } else if (c == '"') {
            break;
        } else {
            out += c;
        }
    }
    return out;
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
        const std::string payload = extract_string_field(m.data, "payload");
        std::lock_guard<std::mutex> g(fd.m);
        std::size_t from = 0;
        for (std::size_t nl; (nl = payload.find('\n', from)) != std::string::npos; from = nl + 1)
            fd.lines.push_back(payload.substr(from, nl - from));
        if (from < payload.size())
            fd.lines.push_back(payload.substr(from));
        ++fd.received;
        while (fd.lines.size() > max_rows)
            fd.lines.pop_front();
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

    std::vector<std::string> rows;
    char filter[256] = "";
    bool follow = true;

    while (!glfwWindowShouldClose(win)) {
        glfwPollEvents();

        bool connected;
        {
            std::lock_guard<std::mutex> g(fd.m);
            connected = fd.connected;
            while (!fd.lines.empty()) {
                rows.push_back(std::move(fd.lines.front()));
                fd.lines.pop_front();
            }
            if (rows.size() > max_rows)
                rows.erase(rows.begin(), rows.begin() + (rows.size() - max_rows));
        }

        ImGui_ImplOpenGL3_NewFrame();
        ImGui_ImplGlfw_NewFrame();
        ImGui::NewFrame();

        const ImGuiViewport* vp = ImGui::GetMainViewport();
        ImGui::SetNextWindowPos(vp->WorkPos);
        ImGui::SetNextWindowSize(vp->WorkSize);
        ImGui::Begin("super-log", nullptr,
                     ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove);

        ImGui::TextColored(connected ? ImVec4(0.4f, 0.8f, 0.4f, 1)
                                     : ImVec4(0.9f, 0.4f, 0.3f, 1),
                           connected ? "live" : "reconnecting...");
        ImGui::SameLine();
        ImGui::Text("%zu rows", rows.size());
        ImGui::SameLine();
        ImGui::Checkbox("follow", &follow);
        ImGui::SameLine();
        ImGui::SetNextItemWidth(-1);
        ImGui::InputTextWithHint("##filter", "filter...", filter, sizeof filter);

        ImGui::BeginChild("rows", ImVec2(0, 0), false,
                          ImGuiWindowFlags_HorizontalScrollbar);
        // TODO(M3): parse rows into events; colour level and topic; columns
        // via ImGuiTableFlags; click-to-expand fields. The React viewer is
        // the behavioural spec.
        ImGuiListClipper clip;
        const std::string needle = filter;
        std::vector<const std::string*> shown;
        shown.reserve(rows.size());
        for (const auto& r : rows)
            if (needle.empty() || r.find(needle) != std::string::npos)
                shown.push_back(&r);
        clip.Begin(static_cast<int>(shown.size()));
        while (clip.Step())
            for (int i = clip.DisplayStart; i < clip.DisplayEnd; ++i)
                ImGui::TextUnformatted(shown[static_cast<std::size_t>(i)]->c_str());
        if (follow && ImGui::GetScrollY() < ImGui::GetScrollMaxY())
            ImGui::SetScrollHereY(1.0f);
        ImGui::EndChild();
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
