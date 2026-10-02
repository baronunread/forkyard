import { CommandPalette } from "@cloudflare/kumo";
import { useEffect, useMemo, useState } from "react";
import { Kbd } from "./ui";
import { useAllCommands, type Command } from "../lib/commands";

interface Group {
  id: string;
  label: string;
  items: Command[];
}

/** ⌘K / Ctrl+K (bound in AppShell): every navigation and view action, keyboard first. */
export function CommandMenu({ open, setOpen }: { open: boolean; setOpen: (o: boolean) => void }) {
  const commands = useAllCommands();
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const groups = useMemo<Group[]>(() => {
    const q = search.trim().toLowerCase();
    const by = new Map<string, Command[]>();
    for (const c of commands) {
      if (q && !`${c.group} ${c.title}`.toLowerCase().includes(q)) continue;
      const list = by.get(c.group) ?? [];
      if (list.length < 30) list.push(c);
      by.set(c.group, list);
    }
    return [...by.entries()].map(([g, items]) => ({ id: g, label: g, items }));
  }, [commands, search]);

  const run = (c: Command) => {
    setOpen(false);
    c.run();
  };

  return (
    <CommandPalette.Root
      open={open}
      onOpenChange={setOpen}
      items={groups}
      value={search}
      onValueChange={setSearch}
      itemToStringValue={(g: Group) => g.label}
      getSelectableItems={(gs: Group[]) => gs.flatMap((g) => g.items)}
      onSelect={(item: Command) => run(item)}
    >
      <CommandPalette.Input placeholder="Jump to an agent, file, task, or action…" />
      <CommandPalette.List>
        <CommandPalette.Results>
          {(group: Group) => (
            <CommandPalette.Group key={group.id} items={group.items}>
              <CommandPalette.GroupLabel>{group.label}</CommandPalette.GroupLabel>
              <CommandPalette.Items>
                {(item: Command) => (
                  <CommandPalette.Item key={item.id} value={item} onClick={() => run(item)}>
                    <span className="flex w-full items-center gap-3">
                      <span className="truncate">{item.title}</span>
                      {item.hint && <Kbd className="ml-auto">{item.hint}</Kbd>}
                    </span>
                  </CommandPalette.Item>
                )}
              </CommandPalette.Items>
            </CommandPalette.Group>
          )}
        </CommandPalette.Results>
        <CommandPalette.Empty>No matches</CommandPalette.Empty>
      </CommandPalette.List>
      <CommandPalette.Footer>
        <span className="flex items-center gap-2">
          <Kbd>↑↓</Kbd> navigate <Kbd>↵</Kbd> run
        </span>
        <span className="flex items-center gap-2">
          <Kbd>[</Kbd>
          <Kbd>]</Kbd> agents <Kbd>j</Kbd>
          <Kbd>k</Kbd> hunks
        </span>
      </CommandPalette.Footer>
    </CommandPalette.Root>
  );
}
