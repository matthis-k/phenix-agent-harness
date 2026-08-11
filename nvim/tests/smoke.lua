local fixture = assert(vim.env.PHENIX_TEST_FIXTURE, "PHENIX_TEST_FIXTURE is required")
local python = assert(vim.env.PHENIX_TEST_PYTHON, "PHENIX_TEST_PYTHON is required")
local config_file = vim.env.PHENIX_TEST_CONFIG

if config_file and config_file ~= "" then
  local configuration = require("phenix.config").load(config_file):params()
  assert(configuration.input.definition_id == "phenix.harness")
  assert(configuration.input.router == "router.mixed")
  assert(#configuration.input.backends > 0)
  assert(#configuration.input.definitions > 0)
end

local phenix = require("phenix")
phenix.setup({
  conductor_command = { python, fixture },
  conductor_cwd_arg = false,
  config = false,
})

assert(vim.fn.maparg("<leader>pp", "n") ~= "", "default Phenix toggle keymap was not installed")

local session = phenix.toggle({ cwd = vim.fn.getcwd() })
assert(vim.wait(5000, function()
  return session:is_ready()
end, 20), "Phenix ACP fixture session did not become ready")
assert(session.session_id == "fixture-session")
assert(session.ui:is_visible(), "sidebar was not visible after the first toggle")

vim.api.nvim_buf_set_lines(session.ui.input_buffer, 0, -1, false, { "hello from neovim" })
assert(session.ui:submit_input(), "input buffer did not submit the prompt")
assert(vim.wait(5000, function()
  return not session.prompting and session.ui:text():find("echo: hello from neovim", 1, true) ~= nil
end, 20), "streamed ACP response did not reach the transcript")

local transcript = session.ui:text()
assert(transcript:find("You: hello from neovim", 1, true), "submitted input was not echoed in the transcript")
assert(transcript:find("Phenix: echo: hello from neovim", 1, true), "assistant text was not rendered plainly")
assert(not transcript:find("thinking about:", 1, true), "thinking should not be rendered in the minimal frontend")

local process = session.client.process
assert(process ~= nil and not session.client.stopped, "ACP process was not running")

phenix.toggle()
assert(not session.ui:is_visible(), "second toggle did not hide the sidebar")
assert(session.client.process == process and not session.client.stopped, "hiding the sidebar stopped the ACP process")

phenix.toggle()
assert(session.ui:is_visible(), "third toggle did not restore the sidebar")
assert(session.client.process == process and not session.client.stopped, "showing the sidebar restarted the ACP process")
assert(session.ui:text():find("echo: hello from neovim", 1, true), "transcript did not survive a sidebar toggle")

phenix.shutdown()
assert(vim.wait(1000, function()
  return session.client.stopped
end, 20), "Phenix ACP fixture did not stop on shutdown")
