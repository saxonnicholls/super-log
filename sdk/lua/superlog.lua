--
--  superlog.lua - the Lua client, stdlib plus curl.
--
--  Copyright 2026 Saxon Herschel Nicholls
--  SPDX-License-Identifier: MIT
--
--  Lua's standard library has no sockets, so this makes the same honest
--  bargain the shell SDK makes: curl carries the bytes, io.popen hands
--  them over, and the SDK stays a single dependency-free file that runs
--  on any Lua 5.1+ (PUC or LuaJIT). The mode comes from SUPERLOG_MODE
--  (development | production) with NO default - unset errors at
--  construction, and production is an inert shell that sends nothing.
--
--    local superlog = require "superlog"
--    local log = superlog.new{ topic = "lua.myapp", app = "myapp" }
--    log:info("up", { port = 3000 })
--
--  Failures never reach the caller: curl's exit status is deliberately
--  ignored, because a logger that can take down the script it observes is
--  worse than no logger. A hub that is down means the next batch counts
--  again.
--

local M = {}

local function esc(s)
  s = tostring(s)
  s = s:gsub('[%c"\\]', function(c)
    if c == '"' then return '\\"' end
    if c == '\\' then return '\\\\' end
    if c == '\n' then return '\\n' end
    if c == '\r' then return '\\r' end
    if c == '\t' then return '\\t' end
    return string.format('\\u%04x', c:byte())
  end)
  return s
end

local Log = {}
Log.__index = Log

function M.new(opt)
  local mode = os.getenv("SUPERLOG_MODE") or ""
  if mode ~= "development" and mode ~= "production" then
    error("superlog: SUPERLOG_MODE is '" .. mode .. "' - declare development "
       .. "or production; there is no default, because deciding is the point.")
  end
  assert(opt and opt.topic, "superlog: topic is required")
  assert(opt.app, "superlog: app is required")
  local host = "lua"
  local p = io.popen("hostname 2>/dev/null")
  if p then
    host = (p:read("*l") or "lua"):lower():match("^[^.]+") or "lua"
    p:close()
  end
  return setmetatable({
    active  = mode == "development",
    url     = opt.url or os.getenv("SUPER_LOG_URL") or "http://127.0.0.1:7333",
    topic   = opt.topic,
    app     = opt.app,
    device  = host,
    session = string.format("%08x", (os.time() * 997 + math.floor(os.clock() * 1e6)) % 0xffffffff),
    seq     = 0,
    buffer  = {},
  }, Log)
end

local function line(self, level, msg, fields, metric)
  local parts = {
    '{"v":1,"ts":"', os.date("!%Y-%m-%dT%H:%M:%SZ"),
    '","seq":', self.seq,
    ',"session":"', self.session,
    '","level":"', level,
    '","origin":{"runtime":"lua","app":"', esc(self.app),
    '","platform":"host","device":"', esc(self.device),
    '"},"tag":"', esc(self.app),
    '","msg":"', esc(msg), '"',
  }
  self.seq = self.seq + 1
  if fields and next(fields) then
    parts[#parts + 1] = ',"fields":{'
    local first = true
    for k, v in pairs(fields) do
      parts[#parts + 1] = (first and "" or ",") .. '"' .. esc(k) .. '":"' .. esc(v) .. '"'
      first = false
    end
    parts[#parts + 1] = "}"
  end
  if metric then
    parts[#parts + 1] = ',"metric":{"name":"' .. esc(metric.name)
                     .. '","value":' .. tostring(metric.value) .. "}"
  end
  parts[#parts + 1] = "}"
  return table.concat(parts)
end

function Log:log(level, msg, fields)
  if not self.active then return end
  self.buffer[#self.buffer + 1] = line(self, level, msg, fields)
  if #self.buffer >= 16 then self:flush() end
end

function Log:metric(name, value)
  if not self.active then return end
  self.buffer[#self.buffer + 1] =
    line(self, "DEBUG", name .. " =" .. tostring(value), nil,
         { name = name, value = value })
  if #self.buffer >= 16 then self:flush() end
end

function Log:trace(m, f)    self:log("TRACE", m, f)    end
function Log:debug(m, f)    self:log("DEBUG", m, f)    end
function Log:info(m, f)     self:log("INFO", m, f)     end
function Log:warn(m, f)     self:log("WARN", m, f)     end
function Log:error(m, f)    self:log("ERROR", m, f)    end
function Log:critical(m, f) self:log("CRITICAL", m, f) end

function Log:flush()
  if not self.active or #self.buffer == 0 then return end
  local body = table.concat(self.buffer, "\n")
  self.buffer = {}
  local cmd = "curl -s -m 3 -X POST --data-binary @- "
           .. "-H 'content-type: application/x-ndjson' '"
           .. self.url .. "/ingest/" .. self.topic .. "' >/dev/null 2>&1"
  local p = io.popen(cmd, "w")
  if p then
    p:write(body)
    p:close()
  end
end

return M
