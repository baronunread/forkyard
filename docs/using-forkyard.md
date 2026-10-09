# Using Forkyard

You decide what should change. Agents do the work, each in its own fork. You hear from them only when they need you, and you pick what ships.

## 1. Start a yard

**Home → New yard.** Give it a name, or paste a GitHub URL to bring a repo and its open issues over. A yard is one project: **Overview · Code · Backlog · Log**.

## 2. Say what should change

Two ways in:

- **New task** (`n`): one line ("Add dark mode"), optional details, and how many agents. Cloud agents start on their own; your own agents (Claude Code, Codex…) take a seat through **Connect an agent**.
- **Backlog**: jot it down with **New item** (or import GitHub issues), and **Start it** when you want agents on it. The item becomes the task's brief.

## 3. Watch the plans, not the keystrokes

Until agents push, the task page opens on **Plans**: what each agent means to do and which files it expects to touch. A file two agents plan to touch is marked on both, and the agents are told before either writes.

You don't need to do anything here. It's where you see early that two agents are heading for the same place.

## 4. Answer only what's asked

If an agent needs a product call, it shows up under **Needs you** on Home and on the task, with one-click answers. The agent keeps working on everything else meanwhile.

## 5. Compare and decide

As agents push, every fork is reviewed and scored.

- **Changes**: one agent's diff, with its intent and review.
- **Compare**: one file, every agent's version side by side.
- **Decide**: ship **one agent's work**, or **combine parts**: one agent's file here, another's change there. Combining starts from the best fork and warns you about files you left out. **Preview**, then **Ship**.

Autopilot does this for you: once everyone has pushed and gone quiet, it merges the best fork that clears the bar, and asks you only when none does. Turn it off on a task to decide yourself.

## 6. Read the result

- **Code**: every folder and file says which task changed it last and which agents did it. Open a file and click the authorship bar to see who wrote each part, and why.
- **Log**: what shipped, day by day, as tasks rather than commits.
- The backlog item closes itself when its task ships.

If the base changed under a task's files before it could merge, autopilot starts it over once from the latest code and tells the agents what landed meanwhile.
