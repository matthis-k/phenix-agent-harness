local M = {}

local Builder = {}
Builder.__index = Builder

local formats = {
  md = "markdown",
  markdown = "markdown",
  json = "json",
  toml = "toml",
  ron = "ron",
}

local difficulties = {
  d0 = true,
  d1 = true,
  d2 = true,
  d3 = true,
  d4 = true,
}

local function fail(message)
  error("phenix config: " .. message, 0)
end

local function nonempty(value, field)
  if type(value) ~= "string" or vim.trim(value) == "" then
    fail(field .. " must be a non-empty string")
  end
  return vim.trim(value)
end

local function check_fields(value, allowed, context)
  if type(value) ~= "table" then
    fail(context .. " must be a table")
  end
  for key in pairs(value) do
    if type(key) ~= "number" and not allowed[key] then
      fail("unknown " .. context .. " field " .. tostring(key))
    end
  end
end

local function authoring_cell(value, field)
  value = nonempty(value, field)
  if value:find("|", 1, true) or value:find("\n", 1, true) or value:find("\r", 1, true) then
    fail(field .. " must be a single Markdown-table-safe line")
  end
  return value
end

local function authoring_atom(value, field)
  value = authoring_cell(value, field)
  if value:find("%s") then
    fail(field .. " must not contain whitespace")
  end
  return value
end

local function authoring_title(value, field)
  value = nonempty(value, field)
  if value:sub(1, 1) == "#" or value:find("\n", 1, true) or value:find("\r", 1, true) then
    fail(field .. " must be a single-line heading without a leading '#'")
  end
  return value
end

local function inline_markdown(source)
  return {
    kind = "inline",
    source = source,
    format = "markdown",
  }
end

local function structured_workflow(value)
  check_fields(value, { id = true, title = true, steps = true }, "workflow definition")
  local id = authoring_atom(value.id, "workflow.id")
  local title = authoring_title(value.title, "workflow.title")
  if type(value.steps) ~= "table" or #value.steps == 0 then
    fail("workflow definition requires at least one step")
  end

  local rows = {}
  for _, step in ipairs(value.steps) do
    check_fields(step, { key = true, parent = true, role = true, objective = true }, "workflow step")
    local parent = step.parent and authoring_cell(step.parent, "workflow step.parent") or "-"
    table.insert(rows, string.format(
      "| %s | %s | %s | %s |",
      authoring_cell(step.key, "workflow step.key"),
      parent,
      authoring_cell(step.role, "workflow step.role"),
      authoring_cell(step.objective, "workflow step.objective")
    ))
  end

  return inline_markdown(string.format(
    "# %s\n\n```phenix-workflow\nid: %s\n```\n\n## Steps\n\n| Key | Parent | Role | Objective |\n|---|---|---|---|\n%s\n",
    title,
    id,
    table.concat(rows, "\n")
  ))
end

local function structured_routing_table(value)
  check_fields(value, { id = true, title = true, routes = true }, "routing table definition")
  local id = authoring_atom(value.id, "routing_table.id")
  local title = authoring_title(value.title, "routing_table.title")
  if type(value.routes) ~= "table" or #value.routes == 0 then
    fail("routing table definition requires at least one route")
  end

  local rows = {}
  for _, route in ipairs(value.routes) do
    check_fields(route, {
      role = true,
      workflow = true,
      d0 = true,
      d1 = true,
      d2 = true,
      d3 = true,
      d4 = true,
      explanation = true,
    }, "routing rule")
    table.insert(rows, string.format(
      "| %s | %s | %s | %s | %s | %s | %s | %s |",
      authoring_cell(route.role, "routing rule.role"),
      authoring_cell(route.workflow, "routing rule.workflow"),
      authoring_cell(route.d0, "routing rule.d0"),
      authoring_cell(route.d1, "routing rule.d1"),
      authoring_cell(route.d2, "routing rule.d2"),
      authoring_cell(route.d3, "routing rule.d3"),
      authoring_cell(route.d4, "routing rule.d4"),
      authoring_cell(route.explanation, "routing rule.explanation")
    ))
  end

  return inline_markdown(string.format(
    "# %s\n\n```phenix-router\nid: %s\n```\n\n## Routes\n\n| Role | Workflow | D0 | D1 | D2 | D3 | D4 | Explanation |\n|---|---|---|---|---|---|---|---|\n%s\n",
    title,
    id,
    table.concat(rows, "\n")
  ))
end

local function source_descriptor(value, kind)
  if type(value) == "string" then
    return {
      kind = "path",
      path = nonempty(value, "definition path"),
    }
  end
  if type(value) ~= "table" then
    fail("definition input must be a relative path string or table")
  end

  if value.path ~= nil or value.source ~= nil then
    check_fields(value, { path = true, source = true, format = true }, "definition")
    if value.path ~= nil and value.source ~= nil then
      fail("definition input must contain either path or source, not both")
    end
    if value.path ~= nil then
      if value.format ~= nil then
        fail("path definitions infer their format from the extension")
      end
      return {
        kind = "path",
        path = nonempty(value.path, "definition path"),
      }
    end
    local format = nil
    if value.format ~= nil then
      format = formats[nonempty(value.format, "definition format"):lower()]
      if not format then
        fail("unsupported definition format " .. tostring(value.format))
      end
    end
    return {
      kind = "inline",
      source = nonempty(value.source, "definition source"),
      format = format,
    }
  end

  if kind == "workflow" then
    return structured_workflow(value)
  end
  return structured_routing_table(value)
end

function M.new(source_root)
  return setmetatable({
    source_root = source_root or vim.fn.getcwd(),
    base = nil,
    backends = {},
    backend_ids = {},
    definitions = {},
  }, Builder)
end

function Builder:api()
  return {
    configure = function(value)
      check_fields(value, { definition_id = true, router = true, standard_session = true }, "phenix.acp.configure")
      if self.base then
        fail("phenix.acp.configure may only be called once per authoring evaluation")
      end
      local standard_session = nil
      if value.standard_session ~= nil then
        local session = value.standard_session
        check_fields(session, { role = true, difficulty = true, objective = true }, "standard_session")
        local difficulty = nonempty(session.difficulty, "standard_session.difficulty"):lower()
        if not difficulties[difficulty] then
          fail("standard_session.difficulty must be d0, d1, d2, d3, or d4")
        end
        standard_session = {
          role = nonempty(session.role, "standard_session.role"),
          difficulty = difficulty,
          objective = nonempty(session.objective, "standard_session.objective"),
        }
      end
      self.base = {
        definition_id = nonempty(value.definition_id, "definition_id"),
        router = nonempty(value.router, "router"),
        standard_session = standard_session,
      }
    end,
    backend = function(value)
      check_fields(value, { id = true, command = true, environment = true }, "backend")
      local id = nonempty(value.id, "backend.id")
      if self.backend_ids[id] then
        fail("duplicate ACP backend " .. id)
      end
      local environment = value.environment or {}
      if type(environment) ~= "table" then
        fail("backend.environment must be a table")
      end
      for key, item in pairs(environment) do
        if type(key) ~= "string" or key == "" or key:find("=", 1, true) or key:find("\0", 1, true) then
          fail("invalid backend.environment key")
        end
        if type(item) ~= "string" or item:find("\0", 1, true) then
          fail("backend.environment values must be NUL-free strings")
        end
      end
      self.backend_ids[id] = true
      table.insert(self.backends, {
        id = id,
        command = nonempty(value.command, "backend.command"),
        environment = vim.deepcopy(environment),
      })
    end,
    workflow = function(value)
      table.insert(self.definitions, {
        kind = "workflow",
        source = source_descriptor(value, "workflow"),
      })
    end,
    routing_table = function(value)
      table.insert(self.definitions, {
        kind = "routing_table",
        source = source_descriptor(value, "routing_table"),
      })
    end,
  }
end

function Builder:load(path)
  path = vim.fs.normalize(path)
  self.source_root = vim.fs.dirname(path)
  local chunk, load_error = loadfile(path)
  if not chunk then
    fail("failed to load " .. path .. ": " .. tostring(load_error))
  end
  local environment = setmetatable({
    phenix = { acp = self:api() },
  }, { __index = _G })
  setfenv(chunk, environment)
  local ok, runtime_error = pcall(chunk)
  if not ok then
    fail("failed to evaluate " .. path .. ": " .. tostring(runtime_error))
  end
  return self
end

function Builder:params()
  if not self.base then
    fail("phenix.acp.configure was not called")
  end
  return {
    source_root = self.source_root,
    input = {
      definition_id = self.base.definition_id,
      router = self.base.router,
      backends = vim.deepcopy(self.backends),
      definitions = vim.deepcopy(self.definitions),
      tools = {},
      standard_session = vim.deepcopy(self.base.standard_session),
    },
  }
end

function M.load(path)
  return M.new(vim.fs.dirname(path)):load(path)
end

M.Builder = Builder

return M
