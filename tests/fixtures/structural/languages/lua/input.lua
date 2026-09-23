-- Unicode before declarations: é😀
local function greet(x, ...)
  local function nested() return x end
  return x
end

function Box:get(x)
  return x
end

function Box.read(self, x)
  return x
end

local value = { secret = 1 }
