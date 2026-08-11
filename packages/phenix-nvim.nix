{ vimUtils }:

vimUtils.buildVimPlugin {
  pname = "phenix-nvim";
  version = "0";
  src = ../nvim;

  meta.description = "Neovim frontend for the Phenix agent harness";
}
