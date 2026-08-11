{
  vimPlugins,
  vimUtils,
}:

vimUtils.buildVimPlugin {
  pname = "phenix-nvim";
  version = "0";
  src = ../nvim;
  dependencies = [ vimPlugins.nui-nvim ];
}
