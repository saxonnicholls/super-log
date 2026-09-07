--
--  clock.lua - the Lua demo client.
--
--  Copyright 2026 Saxon Herschel Nicholls
--  SPDX-License-Identifier: MIT
--
--  The same clock every other demo client runs, once a second on
--  lua.clock. Plain Lua 5.1+ - no sockets library, because the SDK makes
--  the curl bargain.
--
--    SUPERLOG_MODE=development lua demo/lua/clock.lua
--    lua demo/lua/clock.lua --ticks 6       # stop after six, for scripts
--

package.path = (arg[0]:match("^(.*)/") or ".") .. "/../../sdk/lua/?.lua;" .. package.path
local superlog = require "superlog"

local RATES = { BTC = 64000.0, ETH = 3200.0 }

local max_ticks = 0
for i = 1, #arg - 1 do
  if arg[i] == "--ticks" then max_ticks = tonumber(arg[i + 1]) or 0 end
end

local log = superlog.new{ topic = "lua.clock", app = "clock" }

print("superlog: lua clock -> lua.clock")
log:info("lua clock up - one line a second", { lua = _VERSION })

-- Lua has no portable sub-second sleep; a busy os.time() wait would peg a
-- core for a demo about observing load. os.execute("sleep 1") is the same
-- bargain as curl - honest, boring, everywhere.
local tick = 0
while max_ticks == 0 or tick < max_ticks do
  tick = tick + 1
  log:info("tick " .. tick .. " - the time is " .. os.date("!%H:%M:%SZ"),
           { tick = tick })

  -- Honestly wrong every 7th tick, the same staged failure as every other
  -- clock, so one error lines up across every language.
  local symbol = (tick % 7 == 0) and "DOGE" or "BTC"
  local rate = RATES[symbol]
  if rate then
    log:debug("pricing pass " .. tick, { symbol = symbol, price = rate * 2 })
  else
    log:error("pricing failed on tick " .. tick .. ": no rate for " .. symbol,
              { symbol = symbol, tick = tick })
  end

  if tick % 5 == 0 then log:metric("clock.uptime_s", tick) end
  log:flush()
  os.execute("sleep 1")
end

log:info("lua clock stopping")
log:flush()
