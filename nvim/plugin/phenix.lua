if vim.g.loaded_phenix_nvim then
  return
end
vim.g.loaded_phenix_nvim = true

require("phenix")._register_commands()
