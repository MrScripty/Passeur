local quote = require("quote")

if #arg ~= 3 then
  io.stderr:write("usage: lua main.lua UNIT_CENTS QUANTITY DISCOUNT_BPS\n")
  os.exit(2)
end

local result, problem = quote.calculate(
  tonumber(arg[1]),
  tonumber(arg[2]),
  tonumber(arg[3])
)
if not result then
  io.stderr:write(problem, "\n")
  os.exit(2)
end

print(quote.format(result))
