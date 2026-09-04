//
//  superlog_viewer - the native viewer.
//
//  Copyright 2026 Saxon Herschel Nicholls
//  SPDX-License-Identifier: MIT
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

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <ctime>
#include <deque>
#include <fstream>
#include <functional>
#include <map>
#include <mutex>
#include <set>
#include <sstream>
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
                val = val.substr(0, nl) + " ...";
                r.multiline = true;
            }
            if (val.size() > 160)
                val = val.substr(0, 160) + " ...";
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

// ---- the alarm blotter ------------------------------------------------
//
// The sparse window, deliberately unlike the firehose: one row per dedup
// key, newest state wins, repeats counted, recovery greyed rather than
// erased - resolved and forgotten must not look identical. Fed from the
// same drain as the table; alert.* traffic is rare enough that re-parsing
// the raw line here costs nothing.

struct alarm_entry {
    std::string key, msg, topic;
    int level = 4;
    int repeat = 1;
    bool recovered = false;
    double at = 0;                              // ImGui time of last update
};

void note_alarm(std::vector<alarm_entry>& blotter, const row& r, double now)
{
    if (r.topic.rfind("alert.", 0) != 0)
        return;
    const auto j = nlohmann::json::parse(r.raw, nullptr, false);
    alarm_entry e;
    e.topic = r.topic;
    e.msg = r.msg;
    e.level = r.level;
    e.at = now;
    e.key = r.topic;                            // keyless alerts dedup per topic
    if (!j.is_discarded() && j.is_object() && j.contains("fields") && j["fields"].is_object()) {
        const auto& f = j["fields"];
        if (f.contains("key") && f["key"].is_string())
            e.key = f["key"].get<std::string>();
        if (f.contains("repeat") && f["repeat"].is_string())
            e.repeat = std::atoi(f["repeat"].get<std::string>().c_str());
        if (f.contains("kind") && f["kind"] == "recovered")
            e.recovered = true;
    }
    if (r.msg.rfind("RECOVERED", 0) == 0)
        e.recovered = true;
    for (auto& existing : blotter)
        if (existing.key == e.key) {
            existing = std::move(e);
            return;
        }
    blotter.push_back(std::move(e));
}

// ---- the webhook feed --------------------------------------------------
//
// Development's half of the split: wh.* deliveries (Stripe events under
// test, GitHub hooks, a partner's callbacks) with the signature verdict
// and relay status the gateway stamped on arrival. A feed, not a blotter -
// every delivery is its own fact.

struct wh_entry {
    std::string endpoint, msg, body, sig, relay, time;
    int level = 2;
    double at = 0;
};

// A delivery as paste-able text - what a bug report or a diff wants:
// the line the feed shows, then the verdicts, then the payload verbatim.
std::string wh_text(const wh_entry& w)
{
    std::string s = w.time + " " + levels[w.level] + " wh." + w.endpoint + " " + w.msg;
    if (!w.sig.empty()) s += "\n  sig: " + w.sig;
    if (!w.relay.empty()) s += "\n  relay: " + w.relay;
    if (!w.body.empty()) s += "\n" + w.body;
    return s;
}

void note_webhook(std::vector<wh_entry>& feed, const row& r, double now)
{
    if (r.topic.rfind("wh.", 0) != 0)
        return;
    wh_entry e;
    e.endpoint = r.topic.substr(3);
    e.msg = r.msg;
    e.level = r.level;
    e.time = r.time;
    e.at = now;
    const auto j = nlohmann::json::parse(r.raw, nullptr, false);
    if (!j.is_discarded() && j.is_object() && j.contains("fields") && j["fields"].is_object()) {
        const auto& f = j["fields"];
        if (f.contains("body") && f["body"].is_string())
            e.body = f["body"].get<std::string>().substr(0, 2048);
        if (f.contains("sig") && f["sig"].is_string())
            e.sig = f["sig"].get<std::string>();
        if (f.contains("relay_status") && f["relay_status"].is_string())
            e.relay = f["relay_status"].get<std::string>();
    }
    feed.push_back(std::move(e));
    if (feed.size() > 100)
        feed.erase(feed.begin(), feed.begin() + static_cast<std::ptrdiff_t>(feed.size() - 100));
}

// ---- the servers board -------------------------------------------------
//
// Every event carries origin.device, so the hub's traffic IS the server
// list: who has spoken, how recently, and how loudly. No new probes, no
// configuration - a machine joins the board by logging once, whatever
// the mechanism (a vitals reading, a ping metric, an app's own SDK).
// "Last seen" is the last event; silence is grey, not a verdict - an
// alert silence rule is what turns silence into an alarm.

struct server_entry {
    double last_at = 0;                         // ImGui time of last event
    int last_level = 2;
    int worst = 0;                              // loudest level, decaying
    double worst_at = 0;
};

void note_server(std::map<std::string, server_entry>& servers, const row& r, double now)
{
    // Agents carry a device too, but an agent is not a server - it has
    // its own blotter, held to its own cadence.
    if (r.topic.rfind("agent.", 0) == 0)
        return;
    const std::size_t at = r.raw.find("\"device\":\"");
    if (at == std::string::npos)
        return;
    const std::size_t from = at + 10;
    const std::size_t end = r.raw.find('"', from);
    if (end == std::string::npos || end == from || end - from > 63)
        return;
    auto& e = servers[r.raw.substr(from, end - from)];
    e.last_at = now;
    e.last_level = r.level;
    if (r.level >= e.worst || now - e.worst_at > 60) {
        e.worst = r.level;
        e.worst_at = now;
    }
}

// ---- the agents blotter ------------------------------------------------
//
// Who is working the bench: every agent.<name> event is an agent
// listening (MCP connect), requesting (tool calls), or reporting (the
// agent_report contract: which LLM, what task, what cadence). Identity
// fields are STICKY - a requesting DEBUG carries no llm, and forgetting
// who an agent is because it asked a question would be absurd. The light
// is the agent's own promised cadence: grey at 2x means it broke its
// own word, which is exactly what an 8-hour job's watcher needs to see.

struct agent_entry {
    std::string llm, status, task, kind;
    int level = 2;
    int pct = -1;
    double interval_s = 900;
    double at = 0;
};

void note_agent(std::map<std::string, agent_entry>& agents, const row& r, double now)
{
    if (r.topic.rfind("agent.", 0) != 0)
        return;
    auto& e = agents[r.topic.substr(6)];
    e.status = r.msg;
    e.level = r.level;
    e.at = now;
    const auto j = nlohmann::json::parse(r.raw, nullptr, false);
    if (j.is_discarded() || !j.contains("fields") || !j["fields"].is_object())
        return;
    const auto& f = j["fields"];
    const auto str = [&](const char* k) {
        return f.contains(k) && f[k].is_string() ? f[k].get<std::string>() : std::string();
    };
    if (!str("llm").empty()) e.llm = str("llm");
    if (!str("task").empty()) e.task = str("task");
    if (!str("kind").empty()) e.kind = str("kind");
    if (!str("pct").empty()) e.pct = std::atoi(str("pct").c_str());
    if (!str("interval_s").empty()) e.interval_s = std::atof(str("interval_s").c_str());
}

// ---- the PRs board -----------------------------------------------------
//
// superlog-prs publishes one DEBUG row per PR per poll; the board keeps
// the latest per repo#number. Whose move it is - and for how long - is
// the whole point: a PR waiting on US ages amber then red, because 51
// silent days once turned a review request into a stale-close.

struct pr_entry {
    std::string repo, number, title, url, waiting_on, state, last_actor;
    double days = 0;
    bool changes_requested = false;
    double at = 0;
};

void note_pr(std::map<std::string, pr_entry>& prs, const row& r, double now)
{
    if (r.topic.rfind("pr.", 0) != 0)
        return;
    const auto j = nlohmann::json::parse(r.raw, nullptr, false);
    if (j.is_discarded() || !j.contains("fields") || !j["fields"].is_object())
        return;
    const auto& f = j["fields"];
    const auto str = [&](const char* k) {
        return f.contains(k) && f[k].is_string() ? f[k].get<std::string>() : std::string();
    };
    if (str("repo").empty() || str("number").empty())
        return;
    auto& e = prs[str("repo") + "#" + str("number")];
    e.repo = str("repo");
    e.number = str("number");
    if (!str("title").empty()) e.title = str("title");
    if (!str("url").empty()) e.url = str("url");
    if (!str("state").empty()) e.state = str("state");
    if (!str("waiting_on").empty()) e.waiting_on = str("waiting_on");
    if (!str("last_actor").empty()) e.last_actor = str("last_actor");
    if (!str("days_waiting").empty()) e.days = std::atof(str("days_waiting").c_str());
    e.changes_requested = str("changes_requested") == "yes";
    e.at = now;
}

// ---- the device trees --------------------------------------------------
//
// superlog-usb publishes each host's tree as fields.tree on usb.<host>;
// the Devices window renders the latest one per host. Parsed at capture
// (tree events are rare), rendered every frame from the parsed form.

struct usb_state {
    nlohmann::json tree;                        // {name, children[...]}
    double at = 0;                              // ImGui time of last tree
};

// The question the window exists to answer: is my PHONE connected. A
// handset is recognised by name (the tree below is ground truth for
// everything the heuristic misses), remembered for the whole session,
// and shown connected or unplugged - absence must be as visible as
// presence, because "adb can't see the device" starts here.
struct phone_entry {
    std::string label, host, serial;
    bool connected = false;
    double at = 0;                              // when the state last changed
};

bool phone_like(const std::string& name)
{
    static const char* marks[] = {"iphone", "ipad", "ipod", "android", "pixel",
                                  "galaxy", "oneplus", "xiaomi", "huawei", "oppo"};
    std::string l = name;
    for (auto& c : l) c = static_cast<char>(std::tolower(c));
    for (const char* m : marks)
        if (l.find(m) != std::string::npos) return true;
    return false;
}

void scan_phones(std::map<std::string, phone_entry>& phones,
                 const nlohmann::json& node, const std::string& host,
                 std::set<std::string>& present, double now)
{
    if (node.contains("children"))
        for (const auto& c : node["children"]) {
            const std::string name = c.value("name", "");
            if (phone_like(name)) {
                const std::string key = host + "/" + name + "#" + c.value("serial", "");
                present.insert(key);
                auto& p = phones[key];
                if (p.label.empty() || !p.connected) p.at = now;
                p.label = name;
                p.host = host;
                p.serial = c.value("serial", "");
                p.connected = true;
            }
            scan_phones(phones, c, host, present, now);
        }
}

void note_usb(std::map<std::string, usb_state>& trees,
              std::map<std::string, phone_entry>& phones, const row& r, double now)
{
    if (r.topic.rfind("usb.", 0) != 0)
        return;
    const auto j = nlohmann::json::parse(r.raw, nullptr, false);
    if (j.is_discarded() || !j.contains("fields") || !j["fields"].is_object())
        return;
    const auto& f = j["fields"];
    if (!f.contains("tree") || !f["tree"].is_string())
        return;
    const auto t = nlohmann::json::parse(f["tree"].get<std::string>(), nullptr, false);
    if (t.is_discarded() || !t.is_object())
        return;
    const std::string host = r.topic.substr(4);
    auto& e = trees[host];
    e.tree = t;
    e.at = now;
    std::set<std::string> present;
    scan_phones(phones, t, host, present, now);
    for (auto& [key, p] : phones)
        if (p.host == host && p.connected && !present.count(key)) {
            p.connected = false;
            p.at = now;
        }
}

void draw_usb_node(const nlohmann::json& node)
{
    const std::string name = node.value("name", "device");
    std::string detail;
    if (node.contains("vendor") && node["vendor"].is_string())
        detail += node["vendor"].get<std::string>();
    if (node.contains("speed") && node["speed"].is_string())
        detail += (detail.empty() ? "" : ", ") + node["speed"].get<std::string>();
    if (node.contains("serial") && node["serial"].is_string())
        detail += (detail.empty() ? "" : ", sn ") + node["serial"].get<std::string>();
    const bool leaf = !node.contains("children") || node["children"].empty();
    if (leaf) {
        ImGui::BulletText("%s", name.c_str());
        if (!detail.empty()) {
            ImGui::SameLine();
            ImGui::TextDisabled("(%s)", detail.c_str());
        }
        return;
    }
    if (ImGui::TreeNodeEx(name.c_str(), ImGuiTreeNodeFlags_DefaultOpen |
                                        ImGuiTreeNodeFlags_SpanAvailWidth)) {
        if (!detail.empty())
            ImGui::TextDisabled("%s", detail.c_str());
        for (const auto& c : node["children"])
            draw_usb_node(c);
        ImGui::TreePop();
    }
}

// ---- viewer config -----------------------------------------------------
//
// viewer/config.json, shared with the React viewer like menu.json: the
// environment label (auto-detected from the hostname when empty) and
// which clocks ride the menu bar. TAI is UTC + tai_offset_s - 37 since
// 2017, honest until the next leap second, which is the config's problem
// to update, not this code's to guess.

struct viewer_config {
    std::string environment;
    std::vector<std::string> clocks{"local", "utc"};
    int tai_offset = 37;
};

void load_config(viewer_config& vc)
{
    const char* candidates[] = {std::getenv("SUPER_LOG_VIEWER_CONFIG"),
                                "viewer/config.json", "config.json"};
    for (const char* path : candidates) {
        if (!path)
            continue;
        std::ifstream f(path);
        if (!f)
            continue;
        std::stringstream buf;
        buf << f.rdbuf();
        const auto j = nlohmann::json::parse(buf.str(), nullptr, false);
        if (j.is_discarded() || !j.is_object())
            continue;
        vc.environment = j.value("environment", "");
        vc.tai_offset = j.value("tai_offset_s", 37);
        if (j.contains("clocks") && j["clocks"].is_array()) {
            vc.clocks.clear();
            for (const auto& c : j["clocks"])
                if (c.is_string()) vc.clocks.push_back(c.get<std::string>());
        }
        break;
    }
    if (vc.environment.empty()) {
        char hn[256] = "";
        gethostname(hn, sizeof hn - 1);
        vc.environment = hn;
        const auto dot = vc.environment.find('.');
        if (dot != std::string::npos) vc.environment.resize(dot);
        for (auto& c : vc.environment) c = static_cast<char>(std::tolower(c));
    }
}

// The strip on the right of the menu bar: where you are, and when.
std::string env_clock_text(const viewer_config& vc)
{
    const std::time_t now = std::time(nullptr);
    char part[48];
    std::string s = vc.environment;
    for (const auto& c : vc.clocks) {
        std::tm tm{};
        if (c == "local") {
            localtime_r(&now, &tm);
            std::strftime(part, sizeof part, "%H:%M:%S %Z", &tm);
        } else if (c == "utc") {
            gmtime_r(&now, &tm);
            std::strftime(part, sizeof part, "%H:%M:%SZ", &tm);
        } else if (c == "tai") {
            const std::time_t tai = now + vc.tai_offset;
            gmtime_r(&tai, &tm);
            std::strftime(part, sizeof part, "%H:%M:%S TAI", &tm);
        } else {
            continue;
        }
        s += std::string("  \xc2\xb7  ") + part;
    }
    return s;
}

// ---- the menu ----------------------------------------------------------
//
// One menu, two renderers: viewer/menu.json is the definition (asoOne's
// schema - key/label/action/attributes/children, CHECKBOX state seeded by
// "checked") and both this viewer and the React one render it, so the two
// screens carry the same bar. Checkbox state lives HERE, keyed by action;
// the file only seeds it. A missing file falls back to a baked-in copy of
// the same JSON - the menu is how windows are found, so it cannot be
// allowed to vanish with a lost file.

struct menu_state {
    nlohmann::json spec;
    std::map<std::string, bool> toggles;        // action -> checked
};

constexpr const char* fallback_menu = R"MENU([
  {"key":"menu.view","label":"View","attributes":["SUBMENU"],"children":[
    {"key":"menu.view.log","label":"Log firehose","action":"toggle.log","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.servers","label":"Servers (health)","action":"toggle.servers","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.devices","label":"Devices (USB)","action":"toggle.devices","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.agents","label":"Agents (MCP)","action":"toggle.agents","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.prs","label":"PRs (GitHub)","action":"toggle.prs","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.alarms","label":"Alarms (production)","action":"toggle.alarms","attributes":["CHECKBOX"],"checked":true},
    {"key":"menu.view.webhooks","label":"Webhooks (development)","action":"toggle.webhooks","attributes":["CHECKBOX"],"checked":true}]},
  {"key":"menu.actions","label":"Actions","attributes":["SUBMENU"],"children":[
    {"key":"menu.actions.test","label":"Test the alarm path","action":"selftest","attributes":["NORMAL"]}]}
])MENU";

void seed_toggles(menu_state& ms, const nlohmann::json& arr)
{
    if (!arr.is_array())
        return;
    for (const auto& item : arr) {
        const auto attrs = item.value("attributes", nlohmann::json::array());
        for (const auto& a : attrs)
            if (a == "CHECKBOX" && item.contains("action"))
                ms.toggles[item["action"].get<std::string>()] = item.value("checked", false);
        if (item.contains("children"))
            seed_toggles(ms, item["children"]);
    }
}

void load_menu(menu_state& ms)
{
    const char* candidates[] = {std::getenv("SUPER_LOG_MENU"),
                                "viewer/menu.json", "menu.json"};
    for (const char* path : candidates) {
        if (!path)
            continue;
        std::ifstream f(path);
        if (!f)
            continue;
        std::stringstream buf;
        buf << f.rdbuf();
        const auto j = nlohmann::json::parse(buf.str(), nullptr, false);
        if (!j.is_discarded() && j.is_array()) {
            ms.spec = j;
            seed_toggles(ms, ms.spec);
            return;
        }
        std::fprintf(stderr, "menu: %s is not a menu array - using the baked-in menu\n", path);
        break;
    }
    ms.spec = nlohmann::json::parse(fallback_menu);
    seed_toggles(ms, ms.spec);
}

void render_menu_array(const nlohmann::json& arr, menu_state& ms,
                       const std::map<std::string, std::function<void()>>& actions)
{
    if (!arr.is_array())
        return;
    for (const auto& item : arr) {
        const auto attrs = item.value("attributes", nlohmann::json::array());
        const auto has = [&](const char* a) {
            for (const auto& x : attrs) if (x == a) return true;
            return false;
        };
        if (has("HIDDEN"))
            continue;
        if (has("SEPARATOR")) {
            ImGui::Separator();
            continue;
        }
        const std::string label = item.value("label", "");
        const std::string action = item.value("action", "");
        if (has("DISABLED"))
            ImGui::BeginDisabled(true);
        if (has("SUBMENU") || item.contains("children")) {
            if (ImGui::BeginMenu(label.c_str())) {
                if (item.contains("children"))
                    render_menu_array(item["children"], ms, actions);
                ImGui::EndMenu();
            }
        } else if (has("CHECKBOX")) {
            bool& checked = ms.toggles[action];
            if (ImGui::MenuItem(label.c_str(), nullptr, checked)) {
                checked = !checked;
                const auto it = actions.find(action);
                if (it != actions.end()) it->second();
            }
        } else {
            if (ImGui::MenuItem(label.c_str())) {
                const auto it = actions.find(action);
                if (it != actions.end()) it->second();
            }
        }
        if (has("DISABLED"))
            ImGui::EndDisabled();
    }
}

// The gateway's /selftest, via curl on a worker thread - the whole public
// path (hub, tunnel, a round-trip from the internet, channels) with a
// diagnosis per step. curl rather than a hand-rolled client: it is the
// same honest bargain the shell and Haskell SDKs make, and TLS through a
// tunnel is exactly the thing not to hand-roll.
// The gateway's roster - routes with lights, and the one-button endpoint
// factory. Same bargain as the selftest: curl on worker threads, state
// with static storage so a detached thread can never outlive it.
struct gateway_state {
    std::mutex m;
    struct route {
        std::string name, url;
        int healthy = -1;                       // -1 unknown, 0 down, 1 up
        double last_ms = -1;
        long seen_ago_s = -1;                   // derived from last_checked at poll time
        bool deletable = false;
        // The expandable half: every row answers the same questions.
        // public_url is the route itself - what a copy hands you; url is
        // merely what the watchdog pings.
        std::string public_url;
        std::string kind, target, state, last_ok;
        double interval_s = 0;
        int checks = 0, fails = 0;
    };
    std::vector<route> routes;
    bool reachable = false;
    double polled_at = -100;    // in the past, so the first frame polls now
    bool polling = false;
    std::string provision_result;
    bool provisioning = false;
};

long iso_ago_s(const std::string& iso)
{
    if (iso.size() < 19)
        return -1;
    std::tm tm{};
    if (!strptime(iso.c_str(), "%Y-%m-%dT%H:%M:%S", &tm))
        return -1;
    const std::time_t then = timegm(&tm);
    return then > 0 ? static_cast<long>(std::time(nullptr) - then) : -1;
}

void poll_gateway(gateway_state& st, const std::string& gateway)
{
    {
        std::lock_guard<std::mutex> g(st.m);
        if (st.polling)
            return;
        st.polling = true;
    }
    std::thread([&st, gateway] {
        const std::string cmd = "curl -s -m 10 " + gateway + "/healthz 2>/dev/null";
        std::string out;
        if (std::FILE* p = ::popen(cmd.c_str(), "r")) {
            std::array<char, 4096> buf;
            std::size_t n;
            while ((n = std::fread(buf.data(), 1, buf.size(), p)) > 0)
                out.append(buf.data(), n);
            ::pclose(p);
        }
        std::lock_guard<std::mutex> g(st.m);
        st.polling = false;
        st.routes.clear();
        const auto j = nlohmann::json::parse(out, nullptr, false);
        st.reachable = !j.is_discarded() && j.is_object();
        if (!st.reachable)
            return;
        if (j.contains("tunnels"))
            for (const auto& t : j["tunnels"]) {
                gateway_state::route r;
                r.name = t.value("name", "");
                r.url = t.value("url", "");
                if (t.contains("healthy") && t["healthy"].is_boolean())
                    r.healthy = t["healthy"].get<bool>() ? 1 : 0;
                if (t.contains("last_ms") && t["last_ms"].is_number())
                    r.last_ms = t["last_ms"].get<double>();
                if (t.contains("last_checked") && t["last_checked"].is_string())
                    r.seen_ago_s = iso_ago_s(t["last_checked"].get<std::string>());
                r.deletable = t.value("deletable", false);
                r.public_url = t.value("public_url", r.url);
                r.kind = t.value("kind", "");
                if (t.contains("target") && t["target"].is_string()) r.target = t["target"];
                if (t.contains("state") && t["state"].is_string()) r.state = t["state"];
                if (t.contains("last_ok") && t["last_ok"].is_string()) r.last_ok = t["last_ok"];
                if (t.contains("interval_s") && t["interval_s"].is_number())
                    r.interval_s = t["interval_s"].get<double>();
                if (t.contains("checks") && t["checks"].is_number())
                    r.checks = t["checks"].get<int>();
                if (t.contains("fails") && t["fails"].is_number())
                    r.fails = t["fails"].get<int>();
                st.routes.push_back(std::move(r));
            }
        std::fprintf(stderr, "poll_gateway: %zu routes, %zu bytes\n",
                     st.routes.size(), out.size());
    }).detach();
}

void run_gateway_cmd(gateway_state& st, const std::string& cmd, const char* label)
{
    {
        std::lock_guard<std::mutex> g(st.m);
        if (st.provisioning)
            return;
        st.provisioning = true;
        st.provision_result = std::string(label) + "...";
    }
    std::thread([&st, cmd, label] {
        std::string out;
        if (std::FILE* p = ::popen(cmd.c_str(), "r")) {
            std::array<char, 4096> buf;
            std::size_t n;
            while ((n = std::fread(buf.data(), 1, buf.size(), p)) > 0)
                out.append(buf.data(), n);
            ::pclose(p);
        }
        std::lock_guard<std::mutex> g(st.m);
        st.provisioning = false;
        const auto j = nlohmann::json::parse(out, nullptr, false);
        if (j.is_discarded() || !j.is_object())
            st.provision_result = std::string(label) + " failed - is superlog-alarm running?";
        else if (j.value("ok", false))
            st.provision_result = j.contains("url") ? j["url"].get<std::string>()
                                : std::string(label) + " done";
        else
            st.provision_result = std::string(label) + " failed: " + j.value("error", "unknown");
        st.polled_at = 0;                       // refresh the roster next frame
    }).detach();
}

struct selftest_state {
    std::mutex m;
    bool running = false, done = false, ok = false;
    struct step { bool ok; std::string name, detail; };
    std::vector<step> steps;
};

void run_selftest(selftest_state& st, const std::string& gateway)
{
    {
        std::lock_guard<std::mutex> g(st.m);
        if (st.running)
            return;
        st.running = true;
        st.done = false;
        st.steps.clear();
    }
    std::thread([&st, gateway] {
        const std::string cmd =
            "curl -s -m 90 -X POST " + gateway + "/selftest 2>/dev/null";
        std::string out;
        if (std::FILE* p = ::popen(cmd.c_str(), "r")) {
            std::array<char, 4096> buf;
            std::size_t n;
            while ((n = std::fread(buf.data(), 1, buf.size(), p)) > 0)
                out.append(buf.data(), n);
            ::pclose(p);
        }
        std::lock_guard<std::mutex> g(st.m);
        st.running = false;
        st.done = true;
        st.ok = false;
        st.steps.clear();
        const auto j = nlohmann::json::parse(out, nullptr, false);
        if (j.is_discarded() || !j.is_object() || !j.contains("steps")) {
            st.steps.push_back({false, "reach the alarm gateway",
                                gateway + " - no answer. Is superlog-alarm running? (npm run alarm)"});
            return;
        }
        st.ok = j.value("ok", false);
        for (const auto& sj : j["steps"])
            st.steps.push_back({sj.value("ok", false), sj.value("name", ""),
                                sj.value("detail", "")});
    }).detach();
}

// ---- the routes grid ---------------------------------------------------
//
// One function, two windows: the alarms window shows production's routes
// (the gateway's front door and watch-only externals), the webhooks
// window shows development's (capture/relay/forward endpoints). Same
// columns, same expandable diagnostics, because a route is a route -
// which side of the split it lives on is the only difference.

void draw_routes_grid(const std::vector<gateway_state::route>& routes,
                      const std::vector<selftest_state::step>& st_steps,
                      const std::string& gateway,
                      std::string& pending_cmd, const char*& pending_label)
{
    const ImVec4 rt_green(0.41f, 0.79f, 0.39f, 1);
    const ImVec4 rt_red(1.0f, 0.18f, 0.12f, 1);
    const ImVec4 rt_grey(0.45f, 0.47f, 0.52f, 1);
    if (!ImGui::BeginTable("routegrid", 6,
            ImGuiTableFlags_RowBg | ImGuiTableFlags_BordersInnerH |
            ImGuiTableFlags_Resizable | ImGuiTableFlags_SizingStretchProp))
        return;
    ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 36.0f);
    ImGui::TableSetupColumn("route", ImGuiTableColumnFlags_WidthFixed, 104.0f);
    ImGui::TableSetupColumn("url", ImGuiTableColumnFlags_WidthStretch);
    ImGui::TableSetupColumn("seen", ImGuiTableColumnFlags_WidthFixed, 44.0f);
    ImGui::TableSetupColumn("ping", ImGuiTableColumnFlags_WidthFixed, 52.0f);
    ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 104.0f);
    ImGui::TableHeadersRow();
    for (const auto& r : routes) {
        ImGui::PushID(r.name.c_str());
        ImGui::TableNextRow();
        ImGui::TableNextColumn();
        ImGui::TextColored(r.healthy == 1 ? rt_green
                         : r.healthy == 0 ? rt_red : rt_grey,
                           "%s", r.healthy == 1 ? "up"
                               : r.healthy == 0 ? "DOWN" : "--");
        ImGui::TableNextColumn();
        const bool open = ImGui::TreeNodeEx(r.name.c_str(),
                                            ImGuiTreeNodeFlags_SpanAvailWidth);
        ImGui::TableNextColumn();
        {
            std::string u = r.public_url;
            if (u.rfind("https://", 0) == 0) u = u.substr(8);
            ImGui::TextDisabled("%s", u.c_str());
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("%s", r.public_url.c_str());
        }
        ImGui::TableNextColumn();
        if (r.seen_ago_s >= 0) ImGui::TextDisabled("%lds", r.seen_ago_s);
        else ImGui::TextDisabled("-");
        ImGui::TableNextColumn();
        if (r.last_ms >= 0) ImGui::TextDisabled("%dms", static_cast<int>(r.last_ms));
        else ImGui::TextDisabled("-");
        ImGui::TableNextColumn();
        if (ImGui::SmallButton("ping")) {
            pending_cmd = "curl -s -m 25 -X POST " + gateway + "/ping/" + r.name +
                          " 2>/dev/null";
            pending_label = "ping";
        }
        if (ImGui::IsItemHovered())
            ImGui::SetTooltip("measure this route now - same check,\nsame books, just not on the clock");
        ImGui::SameLine();
        if (ImGui::SmallButton("copy"))
            ImGui::SetClipboardText(r.public_url.c_str());
        if (ImGui::IsItemHovered())
            ImGui::SetTooltip("copy the full URL");
        if (r.deletable) {
            ImGui::SameLine();
            if (ImGui::SmallButton("x")) {
                std::string lower = r.name;
                for (auto& c : lower) c = static_cast<char>(std::tolower(c));
                pending_cmd = "curl -s -m 10 -X DELETE " + gateway +
                              "/provision/" + lower + " 2>/dev/null";
                pending_label = "delete";
            }
        }
        if (open) {
            const auto kv = [](const char* k, const std::string& v) {
                ImGui::TableNextRow();
                ImGui::TableSetColumnIndex(1);
                ImGui::TextDisabled("%s", k);
                ImGui::TableSetColumnIndex(2);
                ImGui::PushTextWrapPos();
                ImGui::TextUnformatted(v.c_str());
                ImGui::PopTextWrapPos();
            };
            kv("url", r.public_url);            // the whole route, wrapped
            if (r.url != r.public_url)
                kv("ping target", r.url);
            kv("kind", r.kind + (r.target.empty() ? "" : " -> " + r.target));
            if (r.interval_s > 0)
                kv("ping clock", "every " +
                   std::to_string(static_cast<int>(r.interval_s)) + "s - " +
                   std::to_string(r.checks) + " checks, " +
                   std::to_string(r.fails) + " failing now");
            if (!r.last_ok.empty()) {
                const long ago = iso_ago_s(r.last_ok);
                kv("last ok", ago >= 0 ? std::to_string(ago) + "s ago" : r.last_ok);
            } else {
                kv("last ok", "never");
            }
            if (!r.state.empty())
                kv("tunnel", r.state);
            for (const auto& sp : st_steps) {
                const bool mine = sp.name == "route " + r.name ||
                    (r.name == "ALARM" && sp.name == "public round-trip");
                if (mine)
                    kv(sp.ok ? "last test: ok" : "last test: FAILED", sp.detail);
            }
            ImGui::TreePop();
        }
        ImGui::PopID();
    }
    ImGui::EndTable();
}

} // namespace

int main()
{
    const char* env = std::getenv("SUPER_LOG_URL");
    const std::string origin = env ? env : "ws://127.0.0.1:7333";
    const std::string url = origin + "/ws?topic=*";
    // Shown in the header. With several hubs on one machine - a bench on
    // 7333, a screenshot rig on 7400, a test hub on a random port - "which
    // one am I looking at" is otherwise unanswerable from the window itself,
    // and a viewer pointed at the wrong hub looks exactly like a quiet one.
    const std::string hub_label = [&] {
        std::string h = origin;
        for (const char* pre : {"ws://", "wss://", "http://", "https://"}) {
            const std::size_t n = std::strlen(pre);
            if (h.compare(0, n, pre) == 0) { h = h.substr(n); break; }
        }
        if (const std::size_t slash = h.find('/'); slash != std::string::npos)
            h = h.substr(0, slash);
        return h;
    }();

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
    // Docking: the table, the blotter, and whatever comes next tile the
    // screen however the operator wants, and imgui.ini remembers.
    ImGui::GetIO().ConfigFlags |= ImGuiConfigFlags_DockingEnable;
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
    std::vector<alarm_entry> blotter;
    std::vector<wh_entry> webhooks;
    std::map<std::string, server_entry> servers;
    std::map<std::string, usb_state> usb_trees;
    std::map<std::string, phone_entry> phones;
    std::map<std::string, agent_entry> agents;
    std::map<std::string, pr_entry> prs;
    static menu_state menu;
    load_menu(menu);
    static viewer_config vcfg;
    load_config(vcfg);
    // Static: the selftest runs on a detached thread that may still be
    // writing when main() unwinds - state with static storage cannot be
    // pulled out from under it.
    static selftest_state selftest;
    static gateway_state gwstate;
    static char ep_name[48] = "";
    static char ep_port[8] = "";
    // The gateway lives beside the hub unless SUPER_LOG_ALARM_URL says not.
    const std::string gateway = [&] {
        if (const char* g = std::getenv("SUPER_LOG_ALARM_URL"))
            return std::string(g);
        const std::size_t colon = hub_label.rfind(':');
        return "http://" +
               (colon == std::string::npos ? hub_label : hub_label.substr(0, colon)) +
               ":7336";
    }();

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
                note_alarm(blotter, fd.rows.front(), ImGui::GetTime());
                note_webhook(webhooks, fd.rows.front(), ImGui::GetTime());
                note_server(servers, fd.rows.front(), ImGui::GetTime());
                note_usb(usb_trees, phones, fd.rows.front(), ImGui::GetTime());
                note_agent(agents, fd.rows.front(), ImGui::GetTime());
                note_pr(prs, fd.rows.front(), ImGui::GetTime());
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

        // Snapshot both shared states under their locks, render from the
        // copies, invoke workers only after release - the same mutexes are
        // taken by run_selftest / run_gateway_cmd / poll_gateway, and a
        // std::mutex relocked by its own thread is an abort, not a queue
        // (two buttons paid that lesson already). Hoisted here because the
        // alarms and webhooks windows both draw from them.
        bool st_running, st_done, st_ok;
        std::vector<selftest_state::step> st_steps;
        {
            std::lock_guard<std::mutex> g(selftest.m);
            st_running = selftest.running;
            st_done = selftest.done;
            st_ok = selftest.ok;
            st_steps = selftest.steps;
        }
        std::vector<gateway_state::route> routes;
        bool provisioning = false;
        std::string provision_result;
        bool poll_due = false;
        {
            std::lock_guard<std::mutex> g(gwstate.m);
            if (ImGui::GetTime() - gwstate.polled_at > 30.0) {
                gwstate.polled_at = ImGui::GetTime();
                poll_due = true;
            }
            routes = gwstate.routes;
            provisioning = gwstate.provisioning;
            provision_result = gwstate.provision_result;
        }
        if (poll_due)
            poll_gateway(gwstate, gateway);
        // Production's routes vs development's: the door and the watched
        // externals belong with alarms; the endpoint factory's children
        // belong with webhook testing.
        std::vector<gateway_state::route> prod_routes, dev_routes;
        for (const auto& r : routes) {
            if (r.name == "ALARM" || r.kind == "watch" || r.kind.rfind("gateway", 0) == 0)
                prod_routes.push_back(r);
            else
                dev_routes.push_back(r);
        }

        // The menu is the one thing that can never be lost: every window
        // is a checkbox under View, rendered from viewer/menu.json - the
        // same file the React viewer renders.
        const std::map<std::string, std::function<void()>> menu_actions = {
            {"selftest", [&] { if (!st_running) run_selftest(selftest, gateway); }},
        };
        if (ImGui::BeginMainMenuBar()) {
            render_menu_array(menu.spec, menu, menu_actions);
            // Where you are, and when - right-aligned, from viewer/config.json.
            const std::string ec = env_clock_text(vcfg);
            const float w = ImGui::CalcTextSize(ec.c_str()).x;
            ImGui::SameLine(ImGui::GetWindowWidth() - w - 16.0f);
            ImGui::TextDisabled("%s", ec.c_str());
            ImGui::EndMainMenuBar();
        }

        // The dockspace claims the frame; every window below docks into it
        // (or floats, the operator's call - imgui.ini keeps the layout).
        ImGui::DockSpaceOverViewport(0, vp, ImGuiDockNodeFlags_PassthruCentralNode);
        ImGuiID main_dock = 0;
        if (menu.toggles["toggle.log"]) {
        ImGui::SetNextWindowPos(vp->WorkPos, ImGuiCond_FirstUseEver);
        ImGui::SetNextWindowSize(ImVec2(vp->WorkSize.x - 400, vp->WorkSize.y),
                                 ImGuiCond_FirstUseEver);
        ImGui::Begin("super-log");
        main_dock = ImGui::GetWindowDockID();

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

        // The hub first, because it is the thing that makes every other
        // number on this screen mean something.
        ImGui::TextColored(ImVec4(0.48f, 0.64f, 0.97f, 1), "%s", hub_label.c_str());
        ImGui::SameLine();
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
        // ASCII ">=" and not the nicer "\u2265": ImGui's built-in font carries
        // Basic Latin and Latin-1 only, so anything above U+00FF renders as a
        // literal "?". The web viewer, which has real fonts, keeps the symbol.
        ImGui::Combo("##minlevel", &min_level,
                     ">= TRACE\0>= DEBUG\0>= INFO\0"
                     ">= WARN\0>= ERROR\0>= CRITICAL\0");
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
        }

        // ---- alarms: PRODUCTION's window - the blotter above, the alarm
        // path below (test button + the door's routes). Webhook testing
        // lives next door: both are webhooks, but one is an incident
        // surface and the other is a development tool, and a screen that
        // mixes them teaches the eye to skim past alarms.
        if (menu.toggles["toggle.alarms"]) {
            int firing = 0;
            for (const auto& a : blotter)
                if (!a.recovered && a.level >= 3)
                    ++firing;
            char title[64];
            std::snprintf(title, sizeof title,
                          firing ? "alarms - %d firing###alarms" : "alarms###alarms", firing);
            ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + vp->WorkSize.x - 400,
                                           vp->WorkPos.y + 20), ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(380, 360), ImGuiCond_FirstUseEver);
            ImGui::Begin(title);
            static bool path_open = true;
            const float reserved = path_open
                ? std::min(300.0f, ImGui::GetContentRegionAvail().y * 0.5f)
                : ImGui::GetFrameHeightWithSpacing() + 4.0f;
            ImGui::BeginChild("blotterpane", ImVec2(0, -reserved));
            if (blotter.empty())
                ImGui::TextDisabled("no alarms - which is the idea.");
            // Newest state at the top; a blotter is read from the top.
            for (auto it = blotter.rbegin(); it != blotter.rend(); ++it) {
                const alarm_entry& a = *it;
                const ImVec4 col = a.recovered ? ImVec4(0.41f, 0.79f, 0.39f, 0.7f)
                                               : level_color(a.level);
                ImGui::TextColored(col, "%s %s", a.recovered ? "ok" : "!!", a.key.c_str());
                if (a.repeat > 1) {
                    ImGui::SameLine();
                    ImGui::TextColored(ImVec4(0.85f, 0.64f, 0.25f, 1), "x%d", a.repeat);
                }
                ImGui::SameLine();
                ImGui::TextDisabled("%ds ago", static_cast<int>(ImGui::GetTime() - a.at));
                ImGui::PushTextWrapPos();
                if (a.recovered) ImGui::TextDisabled("%s", a.msg.c_str());
                else ImGui::TextUnformatted(a.msg.c_str());
                ImGui::PopTextWrapPos();
                ImGui::Separator();
            }
            ImGui::EndChild();
            std::string pending_cmd;
            const char* pending_label = nullptr;
            path_open = ImGui::CollapsingHeader("alarm path###alarmpath",
                                                ImGuiTreeNodeFlags_DefaultOpen);
            if (path_open) {
                ImGui::BeginChild("alarmpathpane", ImVec2(0, 0));
                const bool clicked = ImGui::Button(st_running ? "testing..." : "test alarm");
                if (ImGui::IsItemHovered())
                    ImGui::SetTooltip("prove the whole path: hub, tunnel, channels,\n"
                                      "then a public round-trip through EVERY route");
                if (st_done) {
                    int okc = 0;
                    for (const auto& sp : st_steps) okc += sp.ok ? 1 : 0;
                    ImGui::SameLine();
                    ImGui::TextColored(st_ok ? ImVec4(0.41f, 0.79f, 0.39f, 1)
                                             : ImVec4(1.0f, 0.18f, 0.12f, 1),
                                       st_ok ? "PASS" : "FAIL");
                    ImGui::SameLine();
                    ImGui::TextDisabled("%d/%d steps", okc, static_cast<int>(st_steps.size()));
                    ImGui::SameLine();
                    if (ImGui::TreeNodeEx("detail", ImGuiTreeNodeFlags_NoTreePushOnOpen |
                                                    ImGuiTreeNodeFlags_SpanAvailWidth)) {
                        for (const auto& sp : st_steps) {
                            ImGui::TextColored(sp.ok ? ImVec4(0.41f, 0.79f, 0.39f, 1)
                                                     : ImVec4(1.0f, 0.18f, 0.12f, 1),
                                               "%s %s", sp.ok ? "ok" : "X", sp.name.c_str());
                            if (!sp.detail.empty()) {
                                ImGui::PushTextWrapPos();
                                ImGui::TextDisabled("   %s", sp.detail.c_str());
                                ImGui::PopTextWrapPos();
                            }
                        }
                    }
                }
                if (clicked && !st_running)
                    run_selftest(selftest, gateway);
                draw_routes_grid(prod_routes, st_steps, gateway, pending_cmd, pending_label);
                ImGui::EndChild();
            }
            if (pending_label)
                run_gateway_cmd(gwstate, pending_cmd, pending_label);
            ImGui::End();
        }

        // ---- webhooks: DEVELOPMENT's window - the endpoint factory and
        // the deliveries it captures. Stripe events under test land here,
        // signature verdict and relay status stamped, far from the alarms.
        if (menu.toggles["toggle.webhooks"]) {
            char wtitle[64];
            std::snprintf(wtitle, sizeof wtitle, "webhooks - %d###webhooks",
                          static_cast<int>(dev_routes.size()));
            ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + vp->WorkSize.x - 400,
                                           vp->WorkPos.y + 390), ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(380, 360), ImGuiCond_FirstUseEver);
            ImGui::Begin(wtitle);
            std::string pending_cmd;
            const char* pending_label = nullptr;
            draw_routes_grid(dev_routes, st_steps, gateway, pending_cmd, pending_label);
            ImGui::SetNextItemWidth(90);
            ImGui::InputTextWithHint("##epname", "name", ep_name, sizeof ep_name);
            ImGui::SameLine();
            ImGui::SetNextItemWidth(60);
            ImGui::InputTextWithHint("##epport", "port", ep_port, sizeof ep_port);
            ImGui::SameLine();
            if (ImGui::Button(provisioning ? "..." : "+ endpoint") && !provisioning) {
                std::string body = "{";
                if (ep_name[0]) body += std::string("\"name\":\"") + ep_name + "\"";
                if (ep_port[0]) body += std::string(ep_name[0] ? "," : "") +
                                        "\"port\":" + ep_port;
                body += "}";
                pending_cmd = "curl -s -m 60 -X POST " + gateway +
                              "/provision -d '" + body + "' 2>/dev/null";
                pending_label = "provision";
                ep_name[0] = ep_port[0] = '\0';
            }
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("one click, one public URL: forward a\n"
                                  "local port, or capture deliveries\n"
                                  "(blank port) as wh.<name> events -\n"
                                  "relay/secret/local via endpoints.json");
            if (!provision_result.empty()) {
                ImGui::PushTextWrapPos();
                ImGui::TextDisabled("%s", provision_result.c_str());
                ImGui::PopTextWrapPos();
                if (provision_result.rfind("https://", 0) == 0) {
                    ImGui::SameLine();
                    if (ImGui::SmallButton("copy url"))
                        ImGui::SetClipboardText(provision_result.c_str());
                }
            }
            if (pending_label)
                run_gateway_cmd(gwstate, pending_cmd, pending_label);
            ImGui::Separator();
            ImGui::TextDisabled("deliveries");
            // The same two filters the main log has: which stream (here,
            // which endpoint) and how loud. The selection is the NAME, not
            // an index - the endpoint list grows under the combo.
            static char wh_ep_filter[48] = "";      // empty = all endpoints
            static int wh_min_level = 0;
            {
                std::vector<std::string> eps;
                for (const auto& r : dev_routes) {
                    std::string l = r.name;
                    for (auto& c : l) c = static_cast<char>(std::tolower(c));
                    eps.push_back(l);
                }
                for (const auto& w : webhooks)
                    eps.push_back(w.endpoint);
                std::sort(eps.begin(), eps.end());
                eps.erase(std::unique(eps.begin(), eps.end()), eps.end());
                ImGui::SameLine();
                ImGui::SetNextItemWidth(130);
                if (ImGui::BeginCombo("##whep",
                                      wh_ep_filter[0] ? wh_ep_filter : "all endpoints")) {
                    if (ImGui::Selectable("all endpoints", !wh_ep_filter[0]))
                        wh_ep_filter[0] = '\0';
                    for (const auto& e : eps)
                        if (ImGui::Selectable(e.c_str(), e == wh_ep_filter))
                            std::snprintf(wh_ep_filter, sizeof wh_ep_filter, "%s", e.c_str());
                    ImGui::EndCombo();
                }
                ImGui::SameLine();
                ImGui::SetNextItemWidth(90);
                ImGui::Combo("##whlvl", &wh_min_level, levels, 6);
                // Copy the whole (filtered) feed - what the filters show
                // is what the clipboard gets, exactly like the main log.
                static double wh_copied_until = 0;
                ImGui::SameLine();
                if (ImGui::SmallButton(ImGui::GetTime() < wh_copied_until
                                           ? "copied" : "copy all")) {
                    std::string all;
                    int n = 0;
                    for (auto it = webhooks.rbegin(); it != webhooks.rend(); ++it) {
                        if (it->level < wh_min_level) continue;
                        if (wh_ep_filter[0] && it->endpoint != wh_ep_filter) continue;
                        all += wh_text(*it) + "\n\n";
                        ++n;
                    }
                    if (n) ImGui::SetClipboardText(all.c_str());
                    wh_copied_until = ImGui::GetTime() + 1.5;
                }
                if (ImGui::IsItemHovered())
                    ImGui::SetTooltip("every delivery the filters show,\nnewest first, payloads included");
            }
            ImGui::BeginChild("whfeed", ImVec2(0, 0));
            bool any_shown = false;
            if (webhooks.empty())
                ImGui::TextDisabled("none yet - paste an endpoint URL into a\n"
                                    "webhook sender (a Stripe endpoint, a\n"
                                    "GitHub hook) and watch them arrive.");
            int wi = 0;
            for (auto it = webhooks.rbegin(); it != webhooks.rend(); ++it, ++wi) {
                if (it->level < wh_min_level)
                    continue;
                if (wh_ep_filter[0] && it->endpoint != wh_ep_filter)
                    continue;
                any_shown = true;
                ImGui::PushID(wi);
                if (ImGui::SmallButton("copy"))
                    ImGui::SetClipboardText((wh_text(*it) + '\n').c_str());
                ImGui::SameLine();
                ImGui::TextColored(level_color(it->level), "%s", it->endpoint.c_str());
                ImGui::SameLine();
                ImGui::TextUnformatted(it->msg.c_str());
                ImGui::SameLine();
                ImGui::TextDisabled("%ds ago", static_cast<int>(ImGui::GetTime() - it->at));
                if (!it->body.empty() &&
                    ImGui::TreeNodeEx("payload", ImGuiTreeNodeFlags_SpanAvailWidth)) {
                    ImGui::PushTextWrapPos();
                    ImGui::TextDisabled("%s", it->body.c_str());
                    ImGui::PopTextWrapPos();
                    ImGui::TreePop();
                }
                ImGui::Separator();
                ImGui::PopID();
            }
            if (!webhooks.empty() && !any_shown)
                ImGui::TextDisabled("%zu deliveries hidden by the filters above",
                                    webhooks.size());
            ImGui::EndChild();
            ImGui::End();
        }

        // ---- servers: who has spoken, how recently, how loudly. The
        // question this window answers is "is the build box fine" without
        // opening a single log - and when the answer is grey, the logs
        // are one topic filter away in the firehose.
        if (menu.toggles["toggle.servers"]) {
            char stitle[64];
            std::snprintf(stitle, sizeof stitle, "servers - %d###servers",
                          static_cast<int>(servers.size()));
            ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + 20, vp->WorkPos.y + 20),
                                    ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(400, 240), ImGuiCond_FirstUseEver);
            ImGui::Begin(stitle);
            if (servers.empty())
                ImGui::TextDisabled("nobody has spoken yet.");
            if (ImGui::BeginTable("srvgrid", 4,
                    ImGuiTableFlags_RowBg | ImGuiTableFlags_BordersInnerH |
                    ImGuiTableFlags_Resizable | ImGuiTableFlags_SizingStretchProp)) {
                ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 44.0f);
                ImGui::TableSetupColumn("server", ImGuiTableColumnFlags_WidthStretch);
                ImGui::TableSetupColumn("last seen", ImGuiTableColumnFlags_WidthFixed, 80.0f);
                ImGui::TableSetupColumn("loudest (1m)", ImGuiTableColumnFlags_WidthFixed, 86.0f);
                ImGui::TableHeadersRow();
                const double now = ImGui::GetTime();
                for (const auto& [name, e] : servers) {
                    const double ago = now - e.last_at;
                    const bool loud = now - e.worst_at <= 60 && e.worst >= 3;
                    ImGui::TableNextRow();
                    // A machine that shouted recently tints its whole row -
                    // faint enough to read through, loud enough to catch
                    // from across the room.
                    if (loud)
                        ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                            e.worst >= 4 ? IM_COL32(224, 91, 79, 34)
                                         : IM_COL32(217, 164, 65, 26));
                    ImGui::TableNextColumn();
                    // Recency is the health: fresh is green, hesitant is
                    // amber, silence is grey - a verdict this window does
                    // not have the evidence to call "down".
                    if (ago < 120)
                        ImGui::TextColored(ImVec4(0.41f, 0.79f, 0.39f, 1), "up");
                    else if (ago < 600)
                        ImGui::TextColored(ImVec4(0.85f, 0.64f, 0.25f, 1), "quiet");
                    else
                        ImGui::TextColored(ImVec4(0.45f, 0.47f, 0.52f, 1), "silent");
                    ImGui::TableNextColumn();
                    // The same stable hue the firehose gives this machine's
                    // topics, so a server is recognisable across windows.
                    ImGui::TextColored(topic_color(name), "%s", name.c_str());
                    ImGui::TableNextColumn();
                    {
                        const ImVec4 seen = ago < 120
                            ? ImVec4(0.41f, 0.79f, 0.39f, 0.85f)
                            : ago < 600 ? ImVec4(0.85f, 0.64f, 0.25f, 0.85f)
                                        : ImVec4(0.45f, 0.47f, 0.52f, 1);
                        ImGui::TextColored(seen, ago < 90 ? "%ds ago" : "%dm ago",
                                           ago < 90 ? static_cast<int>(ago)
                                                    : static_cast<int>(ago / 60));
                    }
                    ImGui::TableNextColumn();
                    if (loud)
                        ImGui::TextColored(level_color(e.worst), "%s", levels[e.worst]);
                    else if (ago < 120)
                        ImGui::TextColored(level_color(e.last_level), "%s",
                                           levels[e.last_level]);
                    else
                        ImGui::TextDisabled("-");
                }
                ImGui::EndTable();
            }
            ImGui::PushTextWrapPos();
            ImGui::TextDisabled("last seen is the last event heard, whatever the "
                                "mechanism; silence is grey, not a verdict - a "
                                "silence rule in alerts.json turns it into an alarm.");
            ImGui::PopTextWrapPos();
            ImGui::End();
        }

        // ---- devices: each host's USB tree, live. superlog-usb publishes
        // the tree on every change, so plugging a phone in redraws this
        // within one poll; refresh pokes the LOCAL tailer to measure now.
        if (menu.toggles["toggle.devices"]) {
            char dtitle[64];
            std::snprintf(dtitle, sizeof dtitle, "devices - %d host(s)###devices",
                          static_cast<int>(usb_trees.size()));
            ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + 20, vp->WorkPos.y + 280),
                                    ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(420, 320), ImGuiCond_FirstUseEver);
            ImGui::Begin(dtitle);
            if (ImGui::SmallButton("refresh")) {
                // Fire-and-forget poke to the local tailer; remote hosts
                // republish on their own 5s clocks, which is refresh enough.
                std::thread([] {
                    if (std::FILE* p = ::popen(
                            "curl -s -m 20 -X POST http://127.0.0.1:7338/poll >/dev/null 2>&1", "r"))
                        ::pclose(p);
                }).detach();
            }
            if (ImGui::IsItemHovered())
                ImGui::SetTooltip("measure this machine's tree NOW\n(remote hosts republish on their own clocks)");
            ImGui::Separator();
            // The headline: handsets, connected or NOT - absence as
            // visible as presence, because "adb can't see the device"
            // and "Xcode lost the phone" both start here.
            for (const auto& [key, p] : phones) {
                if (p.connected)
                    ImGui::TextColored(ImVec4(0.41f, 0.79f, 0.39f, 1),
                        "# %s - connected (%s)", p.label.c_str(), p.host.c_str());
                else
                    ImGui::TextColored(ImVec4(0.85f, 0.64f, 0.25f, 1),
                        "# %s - UNPLUGGED %ds ago (was on %s)", p.label.c_str(),
                        static_cast<int>(ImGui::GetTime() - p.at), p.host.c_str());
                if (!p.serial.empty() && ImGui::IsItemHovered())
                    ImGui::SetTooltip("serial %s", p.serial.c_str());
            }
            if (!phones.empty())
                ImGui::Separator();
            if (usb_trees.empty()) {
                ImGui::PushTextWrapPos();
                ImGui::TextDisabled("no device trees yet - superlog-usb publishes "
                                    "them (npm run usb; the demo starts it on macOS).");
                ImGui::PopTextWrapPos();
            }
            for (const auto& [host, st] : usb_trees) {
                char hdr[96];
                std::snprintf(hdr, sizeof hdr, "%s  (%ds ago)###usb_%s", host.c_str(),
                              static_cast<int>(ImGui::GetTime() - st.at), host.c_str());
                if (ImGui::CollapsingHeader(hdr, ImGuiTreeNodeFlags_DefaultOpen)) {
                    if (st.tree.contains("children"))
                        for (const auto& c : st.tree["children"])
                            draw_usb_node(c);
                }
            }
            ImGui::End();
        }

        // ---- agents: who is working the bench - listening, requesting,
        // reporting - with the LLM named and the light held to each
        // agent's own promised cadence.
        if (menu.toggles["toggle.agents"]) {
            char atitle[64];
            std::snprintf(atitle, sizeof atitle, "agents - %d###agents",
                          static_cast<int>(agents.size()));
            // Join the main dock node on first appearance - a new window
            // should arrive as a findable tab, not a floating orphan.
            if (main_dock)
                ImGui::SetNextWindowDockID(main_dock, ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowPos(ImVec2(vp->WorkPos.x + 20, vp->WorkPos.y + 620),
                                    ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(480, 240), ImGuiCond_FirstUseEver);
            ImGui::Begin(atitle);
            if (agents.empty()) {
                ImGui::PushTextWrapPos();
                ImGui::TextDisabled("no agents yet. MCP consumers appear when they "
                                    "connect; anything can report with the agent_report "
                                    "tool or one POST to agent.<name>.");
                ImGui::PopTextWrapPos();
            }
            if (ImGui::BeginTable("agentgrid", 5,
                    ImGuiTableFlags_RowBg | ImGuiTableFlags_BordersInnerH |
                    ImGuiTableFlags_Resizable | ImGuiTableFlags_SizingStretchProp)) {
                ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 40.0f);
                ImGui::TableSetupColumn("agent", ImGuiTableColumnFlags_WidthFixed, 110.0f);
                ImGui::TableSetupColumn("llm", ImGuiTableColumnFlags_WidthFixed, 110.0f);
                ImGui::TableSetupColumn("status", ImGuiTableColumnFlags_WidthStretch);
                ImGui::TableSetupColumn("seen", ImGuiTableColumnFlags_WidthFixed, 64.0f);
                ImGui::TableHeadersRow();
                const double now = ImGui::GetTime();
                for (const auto& [name, a] : agents) {
                    const double ago = now - a.at;
                    ImGui::TableNextRow();
                    ImGui::TableNextColumn();
                    // The light is the agent's OWN promise: grey at 2x its
                    // declared cadence means it broke its own word.
                    if (a.level >= 3 && ago < a.interval_s)
                        ImGui::TextColored(level_color(a.level), "%s", levels[a.level]);
                    else if (ago < a.interval_s * 2)
                        ImGui::TextColored(ImVec4(0.41f, 0.79f, 0.39f, 1), "up");
                    else if (ago < a.interval_s * 4)
                        ImGui::TextColored(ImVec4(0.85f, 0.64f, 0.25f, 1), "late");
                    else
                        ImGui::TextColored(ImVec4(0.45f, 0.47f, 0.52f, 1), "silent");
                    ImGui::TableNextColumn();
                    ImGui::TextColored(topic_color(name), "%s", name.c_str());
                    if (!a.task.empty() && ImGui::IsItemHovered())
                        ImGui::SetTooltip("task: %s", a.task.c_str());
                    ImGui::TableNextColumn();
                    ImGui::TextColored(ImVec4(0.48f, 0.64f, 0.97f, 1), "%s",
                                       a.llm.empty() ? "-" : a.llm.c_str());
                    ImGui::TableNextColumn();
                    ImGui::PushTextWrapPos();
                    if (a.pct >= 0) {
                        ImGui::Text("[%d%%] %s", a.pct, a.status.c_str());
                    } else {
                        ImGui::TextUnformatted(a.status.c_str());
                    }
                    ImGui::PopTextWrapPos();
                    ImGui::TableNextColumn();
                    ImGui::TextDisabled(ago < 90 ? "%ds ago" : "%dm ago",
                                        ago < 90 ? static_cast<int>(ago)
                                                 : static_cast<int>(ago / 60));
                }
                ImGui::EndTable();
            }
            ImGui::End();
        }

        // ---- PRs: whose move is it, and for how long. Waiting on US
        // ages amber then red; closed-without-merge stays red, because
        // that is what "closed as stale" looks like from outside.
        if (menu.toggles["toggle.prs"]) {
            char ptitle[64];
            int waiting_us = 0;
            for (const auto& [k, p] : prs)
                if (p.state == "open" && p.waiting_on == "us") ++waiting_us;
            std::snprintf(ptitle, sizeof ptitle,
                          waiting_us ? "PRs - %d waiting on us###prs" : "PRs - %d###prs",
                          waiting_us ? waiting_us : static_cast<int>(prs.size()));
            if (main_dock)
                ImGui::SetNextWindowDockID(main_dock, ImGuiCond_FirstUseEver);
            ImGui::SetNextWindowSize(ImVec2(560, 260), ImGuiCond_FirstUseEver);
            ImGui::Begin(ptitle);
            if (prs.empty()) {
                ImGui::PushTextWrapPos();
                ImGui::TextDisabled("no PRs on the books - superlog-prs watches them "
                                    "(npm run prs -- --author you --repo owner/name).");
                ImGui::PopTextWrapPos();
            }
            if (ImGui::BeginTable("prgrid", 5,
                    ImGuiTableFlags_RowBg | ImGuiTableFlags_BordersInnerH |
                    ImGuiTableFlags_Resizable | ImGuiTableFlags_SizingStretchProp)) {
                ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 52.0f);
                ImGui::TableSetupColumn("pr", ImGuiTableColumnFlags_WidthFixed, 210.0f);
                ImGui::TableSetupColumn("title", ImGuiTableColumnFlags_WidthStretch);
                ImGui::TableSetupColumn("days", ImGuiTableColumnFlags_WidthFixed, 46.0f);
                ImGui::TableSetupColumn("", ImGuiTableColumnFlags_WidthFixed, 44.0f);
                ImGui::TableHeadersRow();
                // Ours-and-oldest first: the sort order IS the to-do list.
                std::vector<const std::pair<const std::string, pr_entry>*> order;
                for (const auto& kv : prs) order.push_back(&kv);
                std::sort(order.begin(), order.end(), [](const auto* a, const auto* b) {
                    const bool au = a->second.waiting_on == "us" && a->second.state == "open";
                    const bool bu = b->second.waiting_on == "us" && b->second.state == "open";
                    if (au != bu) return au;
                    return a->second.days > b->second.days;
                });
                for (const auto* kv : order) {
                    const auto& p = kv->second;
                    ImGui::PushID(kv->first.c_str());
                    ImGui::TableNextRow();
                    const bool ours = p.waiting_on == "us" && p.state == "open";
                    const bool late = ours && p.days >= 3;
                    const bool dead = p.state == "closed";
                    if (dead)
                        ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                                               IM_COL32(224, 91, 79, 34));
                    else if (late)
                        ImGui::TableSetBgColor(ImGuiTableBgTarget_RowBg0,
                            p.days >= 9 ? IM_COL32(224, 91, 79, 30)
                                        : IM_COL32(217, 164, 65, 24));
                    ImGui::TableNextColumn();
                    if (dead)
                        ImGui::TextColored(ImVec4(1.0f, 0.18f, 0.12f, 1), "closed");
                    else if (p.state == "merged")
                        ImGui::TextColored(ImVec4(0.48f, 0.64f, 0.97f, 1), "merged");
                    else if (ours)
                        ImGui::TextColored(late ? (p.days >= 9 ? ImVec4(1.0f, 0.18f, 0.12f, 1)
                                                               : ImVec4(0.85f, 0.64f, 0.25f, 1))
                                                : ImVec4(0.41f, 0.79f, 0.39f, 1), "OURS");
                    else
                        ImGui::TextColored(ImVec4(0.45f, 0.47f, 0.52f, 1), "theirs");
                    ImGui::TableNextColumn();
                    ImGui::TextColored(topic_color(p.repo), "%s#%s",
                                       p.repo.c_str(), p.number.c_str());
                    if (ImGui::IsItemHovered() && !p.last_actor.empty())
                        ImGui::SetTooltip("last word: %s%s", p.last_actor.c_str(),
                                          p.changes_requested ? "\n(changes requested)" : "");
                    ImGui::TableNextColumn();
                    ImGui::PushTextWrapPos();
                    ImGui::TextUnformatted(p.title.c_str());
                    ImGui::PopTextWrapPos();
                    ImGui::TableNextColumn();
                    ImGui::TextColored(late ? ImVec4(0.85f, 0.64f, 0.25f, 1)
                                            : ImVec4(0.45f, 0.47f, 0.52f, 1),
                                       "%.1f", p.days);
                    ImGui::TableNextColumn();
                    if (ImGui::SmallButton("copy"))
                        ImGui::SetClipboardText(p.url.c_str());
                    if (ImGui::IsItemHovered())
                        ImGui::SetTooltip("%s", p.url.c_str());
                    ImGui::PopID();
                }
                ImGui::EndTable();
            }
            ImGui::PushTextWrapPos();
            ImGui::TextDisabled("waiting on US ages amber at 3d, red at 9d, and "
                                "fires the alarm gateway - 51 silent days once "
                                "turned a review request into a stale-close.");
            ImGui::PopTextWrapPos();
            ImGui::End();
        }

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
