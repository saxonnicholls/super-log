// ai_panel.hpp - the "AI interpretation" panel: a thin CLIENT of super-log Cloud.
//
// Copyright 2026 Saxon Herschel Nicholls
// SPDX-License-Identifier: MIT
//
// It reads ~/.superlog/cloud.json (written by the COMMERCIAL `superlog-cloud
// login`; token issuance and billing are commercial and never live here), asks
// the Cloud whether this org is entitled, and either interprets the bench or
// renders the server's own upsell offer. Only two strings are hardwired - the
// api_base default and the /connect door - so every price, seat count and word
// of copy is server-driven and changes without a viewer release. Findings are
// rendered as TEXT, never markup (log content is data, all the way to the
// model and back: the log4j rule). curl on a worker thread, exactly like the
// gateway panel; state has long-lived storage so a detached thread never
// outlives it.
#pragma once

#include <array>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iterator>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

#include <nlohmann/json.hpp>
#include <imgui.h>

struct ai_state {
    std::mutex m;

    // Config (from cloud.json / env), with the only two hardwired strings.
    std::string api_base    = "https://api.super-log.com";
    std::string connect_url = "https://super-log.com/connect";
    std::string token, org, org_name, bench;
    bool signed_in = false;
    bool loaded    = false;
    bool refreshing = false;
    std::string error;

    // Entitlement (server-enforced; we only display it).
    int  entitled = -1;                    // -1 unknown, 0 no, 1 yes
    std::string plan, reason;
    long q_included = -1, q_used = -1, q_remaining = -1;

    // The offer - all copy server-driven.
    bool have_offer = false;
    std::string headline, body, cta_label = "Start free", cta_url;
    struct tier { std::string name, price, blurb; long seats = -1; };
    std::vector<tier> tiers;

    // Interpretation.
    int  audience = 0;                     // 0 technical, 1 executive
    bool interpreting = false;
    std::string reading_state, reading_text, measure;
    std::vector<std::string> top_topics;
};

// Single-quote-escape for a value going into a /bin/sh command (the token, a
// URL, a JSON body). '\'' closes, escapes a literal quote, reopens.
inline std::string ai_shq(const std::string& s)
{
    std::string o = "'";
    for (char c : s) { if (c == '\'') o += "'\\''"; else o += c; }
    return o + "'";
}

inline std::string ai_run(const std::string& cmd)
{
    std::string out;
    if (std::FILE* p = ::popen(cmd.c_str(), "r")) {
        std::array<char, 8192> buf;
        std::size_t n;
        while ((n = std::fread(buf.data(), 1, buf.size(), p)) > 0)
            out.append(buf.data(), n);
        ::pclose(p);
    }
    return out;
}

inline void ai_open_url(const std::string& url)
{
#if defined(__APPLE__)
    std::system(("open " + ai_shq(url) + " >/dev/null 2>&1 &").c_str());
#elif defined(_WIN32)
    std::system(("start \"\" " + ai_shq(url)).c_str());
#else
    std::system(("xdg-open " + ai_shq(url) + " >/dev/null 2>&1 &").c_str());
#endif
}

// Caller holds s.m.
inline void ai_load_config_locked(ai_state& s)
{
    if (const char* e = std::getenv("SUPER_LOG_AI_BASE")) if (*e) s.api_base = e;
    const char* home = std::getenv("HOME");
    if (!home) return;
    std::ifstream f(std::string(home) + "/.superlog/cloud.json");
    if (!f) return;                                    // absent = not signed in
    std::string content((std::istreambuf_iterator<char>(f)),
                        std::istreambuf_iterator<char>());
    const auto j = nlohmann::json::parse(content, nullptr, false);
    if (j.is_discarded() || !j.is_object()) return;
    s.token    = j.value("agent_token", "");
    s.org      = j.value("org", "");
    s.org_name = j.value("org_name", "");
    s.bench    = j.value("bench", "");
    if (j.contains("api_base") && j["api_base"].is_string())
        s.api_base = j["api_base"].get<std::string>();
    s.signed_in = !s.token.empty();
}

inline void ai_apply_offer_locked(ai_state& s, const nlohmann::json& j)
{
    s.headline = j.value("headline", "AI interpretation");
    s.body     = j.value("body", "");
    s.tiers.clear();
    if (j.contains("tiers") && j["tiers"].is_array())
        for (const auto& t : j["tiers"]) {
            ai_state::tier ti;
            ti.name  = t.value("name", "");
            ti.blurb = t.value("blurb", "");
            if (t.contains("seats") && t["seats"].is_number())
                ti.seats = t["seats"].get<long>();
            if (t.contains("price_usd_month") && t["price_usd_month"].is_number())
                ti.price = "$" + std::to_string(t["price_usd_month"].get<long>()) + "/mo";
            s.tiers.push_back(ti);
        }
    if (j.contains("cta") && j["cta"].is_object()) {
        s.cta_label = j["cta"].value("label", s.cta_label);
        s.cta_url   = j["cta"].value("url", s.connect_url);
    }
    s.have_offer = true;
}

// Fetch the server-driven offer (unauthenticated). Spawns a worker; caller holds s.m.
inline void ai_start_offer_locked(ai_state& s)
{
    s.refreshing = true;
    const std::string base = s.api_base;
    std::thread([&s, base] {
        const std::string out = ai_run("curl -s -m 8 " + ai_shq(base + "/ai/offer") + " 2>/dev/null");
        std::lock_guard<std::mutex> g(s.m);
        s.refreshing = false;
        const auto j = nlohmann::json::parse(out, nullptr, false);
        if (j.is_discarded() || !j.is_object()) { s.error = "offer unreachable"; return; }
        s.error.clear();
        ai_apply_offer_locked(s, j);
    }).detach();
}

// Fetch entitlement (Bearer). Spawns a worker; caller holds s.m.
inline void ai_start_entitlement_locked(ai_state& s)
{
    s.refreshing = true;
    const std::string base = s.api_base, tok = s.token;
    std::thread([&s, base, tok] {
        const std::string out = ai_run(
            "curl -s -m 8 -H " + ai_shq("Authorization: Bearer " + tok) + " " +
            ai_shq(base + "/ai/entitlement") + " 2>/dev/null");
        std::lock_guard<std::mutex> g(s.m);
        s.refreshing = false;
        const auto j = nlohmann::json::parse(out, nullptr, false);
        if (j.is_discarded() || !j.is_object()) { s.error = "cloud unreachable"; return; }
        s.error.clear();
        const bool ent = j.value("entitled", false);
        s.entitled = ent ? 1 : 0;
        s.plan     = j.value("plan", "");
        s.reason   = j.value("reason", "");
        if (j.contains("interpretations") && j["interpretations"].is_object()) {
            const auto& q = j["interpretations"];
            s.q_included  = q.value("included", -1);
            s.q_used      = q.value("used", -1);
            s.q_remaining = q.value("remaining", -1);
        }
        // Not entitled? we'll want the offer to render the upsell.
        if (!ent && !s.have_offer) ai_start_offer_locked(s);
    }).detach();
}

// Interpret the whole bench (kind=bench). Spawns a worker; caller holds s.m.
inline void ai_start_interpret_locked(ai_state& s)
{
    s.interpreting = true;
    s.reading_state = "pending";
    const std::string base = s.api_base, tok = s.token;
    const std::string aud = s.audience == 0 ? "technical" : "executive";
    nlohmann::json body{{"audience", aud}, {"kind", "bench"}, {"wait_ms", 20000}};
    const std::string data = body.dump();
    std::thread([&s, base, tok, data] {
        const std::string out = ai_run(
            "curl -s -m 30 -X POST"
            " -H " + ai_shq("Authorization: Bearer " + tok) +
            " -H " + ai_shq("Content-Type: application/json") +
            " --data " + ai_shq(data) + " " +
            ai_shq(base + "/ai/interpret") + " 2>/dev/null");
        std::lock_guard<std::mutex> g(s.m);
        s.interpreting = false;
        const auto j = nlohmann::json::parse(out, nullptr, false);
        if (j.is_discarded() || !j.is_object() || !j.value("ok", false)) {
            s.reading_state = "failed";
            s.reading_text  = "The interpreter did not answer. Is the hub reachable, and your subscription active?";
            return;
        }
        const auto& r = j["reading"];
        s.reading_state = r.value("state", "ready");
        s.reading_text  = r.value("text", "");
        s.top_topics.clear();
        if (r.contains("context") && r["context"].contains("topTopics"))
            for (const auto& t : r["context"]["topTopics"])
                if (t.is_string()) s.top_topics.push_back(t.get<std::string>());
        if (r.contains("measure") && r["measure"].is_object()) {
            const auto& mm = r["measure"];
            s.measure = "prompt " + std::to_string(mm.value("promptTokens", 0)) +
                        "  out " + std::to_string(mm.value("completionTokens", 0)) +
                        "  " + std::to_string(mm.value("totalMs", 0)) + "ms";
        }
        if (j.contains("quota") && j["quota"].is_object()) {
            const auto& q = j["quota"];
            if (q.contains("remaining") && q["remaining"].is_number())
                s.q_remaining = q["remaining"].get<long>();
        }
    }).detach();
}

// The panel. Called once per frame on the UI thread when its toggle is on.
inline void render_ai_panel(ai_state& s)
{
    ImGui::Begin("AI interpretation");
    {
        std::lock_guard<std::mutex> g(s.m);
        if (!s.loaded) { s.loaded = true; ai_load_config_locked(s); }
        if (!s.refreshing) {
            if (s.signed_in && s.entitled < 0) ai_start_entitlement_locked(s);
            else if ((!s.signed_in || s.entitled == 0) && !s.have_offer)
                ai_start_offer_locked(s);
        }
    }

    // Snapshot under the lock, render outside it.
    ai_state::tier tiers_copy_storage;
    std::lock_guard<std::mutex> g(s.m);

    if (s.entitled == 1) {
        // ---- Entitled: interpret the bench ------------------------------
        ImGui::TextDisabled("%s%s", s.org_name.empty() ? "signed in" : s.org_name.c_str(),
                            s.plan.empty() ? "" : ("  -  " + s.plan).c_str());
        if (s.q_remaining >= 0)
            ImGui::TextDisabled("%ld interpretations left this month", s.q_remaining);
        ImGui::Separator();

        ImGui::TextUnformatted("Read as:");
        ImGui::SameLine();
        ImGui::SetNextItemWidth(220);
        ImGui::Combo("##aud", &s.audience, "Technical - for the engineers\0Management - for the C-suite\0");
        ImGui::SameLine();
        ImGui::BeginDisabled(s.interpreting);
        if (ImGui::Button(s.reading_text.empty() ? "Interpret now" : "Refresh"))
            ai_start_interpret_locked(s);
        ImGui::EndDisabled();

        if (s.interpreting) ImGui::TextDisabled("reading the last 15 minutes of the bench...");
        ImGui::Separator();

        if (!s.reading_text.empty()) {
            ImGui::PushTextWrapPos(0.0f);
            ImGui::TextUnformatted(s.reading_text.c_str());   // TEXT, never markup
            ImGui::PopTextWrapPos();
            if (!s.top_topics.empty()) {
                ImGui::Spacing();
                std::string t = "read: ";
                for (std::size_t i = 0; i < s.top_topics.size() && i < 6; ++i)
                    t += (i ? ", " : "") + s.top_topics[i];
                ImGui::TextDisabled("%s", t.c_str());
            }
            if (!s.measure.empty()) ImGui::TextDisabled("%s", s.measure.c_str());
        } else if (!s.interpreting) {
            ImGui::TextDisabled("Ask the bench what just happened - pick an audience and Interpret.");
        }
    } else {
        // ---- Not entitled: the server's upsell (all copy server-driven) --
        if (!s.have_offer) {
            ImGui::TextDisabled("%s", s.error.empty() ? "loading..." : s.error.c_str());
        } else {
            if (!s.headline.empty())
                ImGui::TextColored(ImVec4(0.48f, 0.64f, 0.97f, 1), "%s", s.headline.c_str());
            if (!s.body.empty()) {
                ImGui::PushTextWrapPos(0.0f);
                ImGui::TextUnformatted(s.body.c_str());
                ImGui::PopTextWrapPos();
            }
            ImGui::Spacing();
            for (const auto& t : s.tiers) {
                std::string line = t.name;
                if (t.seats >= 0) line += "  -  " + std::to_string(t.seats) + " seat(s)";
                if (!t.price.empty()) line += "  -  " + t.price;
                ImGui::BulletText("%s", line.c_str());
                if (!t.blurb.empty()) { ImGui::SameLine(); ImGui::TextDisabled("%s", t.blurb.c_str()); }
            }
            ImGui::Spacing();
            const std::string url = s.cta_url.empty() ? s.connect_url : s.cta_url;
            if (ImGui::Button(s.cta_label.empty() ? "Start free" : s.cta_label.c_str()))
                ai_open_url(url);
            ImGui::SameLine();
            ImGui::TextDisabled("opens %s", url.c_str());
        }
    }
    (void)tiers_copy_storage;
    ImGui::End();
}
