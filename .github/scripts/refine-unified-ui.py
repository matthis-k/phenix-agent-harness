from pathlib import Path

path = Path("modules/phenix-pi/extension/phenix-ui.ts")
text = path.read_text()

old = '''  private snapshot: PhenixUiSnapshot;
  private view: PhenixUiView;
  private pane: UiPane = 0;
  private filter = "";
  private filtering = false;
'''
new = '''  private snapshot: PhenixUiSnapshot;
  private view: PhenixUiView;
  private readonly panes: Record<PhenixUiView, UiPane> = {
    status: 0,
    runs: 0,
    facts: 0,
    catalog: 0,
  };
  private readonly filters: Record<PhenixUiView, string> = {
    status: "",
    runs: "",
    facts: "",
    catalog: "",
  };
  private filtering = false;
'''
assert old in text
text = text.replace(old, new, 1)

collapsed = '''  private readonly collapsedRuns = new Set<string>();
'''
assert collapsed in text
text = text.replace(
    collapsed,
    '''  private readonly collapsedRuns = new Set<string>();
  private readonly manuallyExpandedRuns = new Set<string>();
''',
    1,
)

constructor = '''  constructor(options: PhenixUiOptions) {
'''
assert constructor in text
text = text.replace(
    constructor,
    '''  private get pane(): UiPane {
    return this.panes[this.view];
  }

  private set pane(value: UiPane) {
    this.panes[this.view] = value;
  }

  private get filter(): string {
    return this.filters[this.view];
  }

  private set filter(value: string) {
    this.filters[this.view] = value;
  }

  constructor(options: PhenixUiOptions) {
''',
    1,
)

switch = '''  private switchView(view: PhenixUiView): void {
    this.view = view;
    this.pane = 0;
    this.goPrefix = false;
'''
assert switch in text
text = text.replace(
    switch,
    '''  private switchView(view: PhenixUiView): void {
    this.view = view;
    this.goPrefix = false;
''',
    1,
)

runs = '''    const runs = flattenRuns(this.snapshot.tree.root, new Set())
      .filter((item) => item.node.run.id !== this.snapshot.tree.root.run.id)
      .filter((item) => !TERMINAL_STATES.has(item.node.run.state));
'''
assert text.count(runs) == 2
text = text.replace(runs, '''    const runs = this.statusRuns();
''')
text = text.replace(
    '''    runs.slice(0, Math.max(3, Math.floor(this.layout.bodyHeight / 2) - 4)).forEach((run, index) => {
''',
    '''    runs.forEach((run, index) => {
''',
    1,
)

target_marker = '''  private statusTargets(): readonly ({ readonly kind: "run"; readonly item: FlatRun } | { readonly kind: "fact"; readonly item: RunFact })[] {
'''
assert target_marker in text
text = text.replace(
    target_marker,
    '''  private statusRuns(): readonly FlatRun[] {
    return flattenRuns(this.snapshot.tree.root, new Set())
      .filter((item) => item.node.run.id !== this.snapshot.tree.root.run.id)
      .filter((item) => !TERMINAL_STATES.has(item.node.run.state))
      .slice(0, Math.max(3, Math.floor(this.layout.bodyHeight / 2) - 4));
  }

  private statusTargets(): readonly ({ readonly kind: "run"; readonly item: FlatRun } | { readonly kind: "fact"; readonly item: RunFact })[] {
''',
    1,
)

preview = '''    try {
      lines = renderRunTreeSequence({ root: node }, { expanded: true }).split("\\n");
'''
assert preview in text
text = text.replace(
    preview,
    '''    try {
      const root =
        node.run.kind === "root" ? node : { ...this.snapshot.tree.root, children: [node] };
      lines = renderRunTreeSequence({ root }, { expanded: true }).split("\\n");
''',
    1,
)

medium = '''    if (width < 82) {
      const content =
        this.pane === 0
          ? this.renderRunTreePane(flat, selectedIndex, width, height)
          : this.pane === 1
            ? this.renderRunPreviewPane(selected, width, height)
            : this.renderRunInspectorPane(selected, width, height);
      return content;
    }
    const treeWidth = Math.min(46, Math.max(30, Math.floor(width * 0.32)));
'''
assert medium in text
text = text.replace(
    medium,
    '''    if (width < 82) {
      const content =
        this.pane === 0
          ? this.renderRunTreePane(flat, selectedIndex, width, height)
          : this.pane === 1
            ? this.renderRunPreviewPane(selected, width, height)
            : this.renderRunInspectorPane(selected, width, height);
      return content;
    }
    if (width < 126 && this.pane === 2) {
      return this.renderRunInspectorPane(selected, width, height);
    }
    const treeWidth = Math.min(46, Math.max(30, Math.floor(width * 0.32)));
''',
    1,
)

mouse = '''  private handleMouseWheel(direction: number, x: number): void {
    if (this.view === "runs" && this.layout.width >= 82) {
      this.pane = x <= this.layout.sidebarWidth ? 0 : this.pane;
    } else if ((this.view === "facts" || this.view === "catalog") && x <= this.layout.sidebarWidth) {
      this.pane = 0;
    }
'''
assert mouse in text
text = text.replace(
    mouse,
    '''  private handleMouseWheel(direction: number, x: number): void {
    if (this.view === "runs" && this.layout.width >= 82) {
      const treeWidth = Math.min(46, Math.max(30, Math.floor(this.layout.width * 0.32)));
      if (x <= treeWidth) this.pane = 0;
      else if (this.layout.width >= 126) {
        const inspectorWidth = Math.min(42, Math.floor(this.layout.width * 0.28));
        this.pane = x > this.layout.width - inspectorWidth ? 2 : 1;
      } else this.pane = 1;
    } else if (this.view === "facts" && this.layout.width >= 76) {
      const listWidth = Math.min(68, Math.max(38, Math.floor(this.layout.width * 0.55)));
      this.pane = x <= listWidth ? 0 : 1;
    } else if (this.view === "catalog" && this.layout.width >= 76) {
      this.pane = x <= this.layout.sidebarWidth ? 0 : 1;
    }
''',
    1,
)

reset = '''  private resetSelectionForFilter(): void {
    this.selectedStatus = 0;
    this.selectedFact = 0;
    this.selectedDefinition = 0;
    this.runHorizontalOffset = 0;
    this.runVerticalOffset = 0;
    this.catalogHorizontalOffset = 0;
    this.catalogVerticalOffset = 0;
    this.previewCache = undefined;
  }
'''
assert reset in text
text = text.replace(
    reset,
    '''  private resetSelectionForFilter(): void {
    switch (this.view) {
      case "status":
        this.selectedStatus = 0;
        break;
      case "runs":
        this.runHorizontalOffset = 0;
        this.runVerticalOffset = 0;
        break;
      case "facts":
        this.selectedFact = 0;
        this.factDetailOffset = 0;
        break;
      case "catalog":
        this.selectedDefinition = 0;
        this.catalogHorizontalOffset = 0;
        this.catalogVerticalOffset = 0;
        break;
    }
    this.previewCache = undefined;
  }
''',
    1,
)

toggle = '''  private toggleRun(node: RunTreeNode): void {
    if (node.children.length === 0) return;
    const id = String(node.run.id);
    if (this.collapsedRuns.has(id)) this.collapsedRuns.delete(id);
    else this.collapsedRuns.add(id);
  }
'''
assert toggle in text
text = text.replace(
    toggle,
    '''  private toggleRun(node: RunTreeNode): void {
    if (node.children.length === 0) return;
    const id = String(node.run.id);
    if (this.collapsedRuns.has(id)) {
      this.collapsedRuns.delete(id);
      this.manuallyExpandedRuns.add(id);
    } else {
      this.collapsedRuns.add(id);
      this.manuallyExpandedRuns.delete(id);
    }
  }
''',
    1,
)

collapse = '''  private initializeCollapsedRuns(node: RunTreeNode): void {
    if (node.run.kind === "workflow" && TERMINAL_STATES.has(node.run.state)) {
      this.collapsedRuns.add(String(node.run.id));
    }
'''
assert collapse in text
text = text.replace(
    collapse,
    '''  private initializeCollapsedRuns(node: RunTreeNode): void {
    const id = String(node.run.id);
    if (
      node.run.kind === "workflow" &&
      TERMINAL_STATES.has(node.run.state) &&
      !this.manuallyExpandedRuns.has(id)
    ) {
      this.collapsedRuns.add(id);
    }
''',
    1,
)

refresh = '''        this.snapshot = await this.load();
        this.previewCache = undefined;
        this.requestRender();
'''
assert refresh in text
text = text.replace(
    refresh,
    '''        const snapshot = await this.load();
        if (this.disposed) return;
        this.snapshot = snapshot;
        this.initializeCollapsedRuns(snapshot.tree.root);
        this.previewCache = undefined;
        this.requestRender();
''',
    1,
)

path.write_text(text)
