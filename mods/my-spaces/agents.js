// Which agent runs in each tab of a space. Pure, so it can be tested without Herdr.

// Keys of the programs Herdr lists as agents (its `new-menu.agents` table, per machine). Herdr
// flags a running program as an agent only once it reports a status, and opencode never does.
export function agentKeys(table) {
  return new Set(Object.values(table ?? {}).flat().filter(item => item?.agent).map(item => item.key));
}

// One entry per tab that runs an agent, in tab order: the first such pane's program and the
// tab's most urgent agent status (null: nothing to report). `ps` is panes(); `keys` agentKeys().
export function agentTabs(space, ps, keys) {
  return (space.tabs ?? []).flatMap(tab => {
    const pane = ps.find(p => p.tab === tab.id && p.terminal && p.program && !p.program.shell
      && (p.program.agent || keys.has(p.program.key)));
    return pane ? [{ id: tab.id, name: tab.name, program: pane.program, status: tab.status ?? null }] : [];
  });
}
