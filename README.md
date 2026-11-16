# Claude usage meter

A Claude Code mod that shows your usage in a band above the prompt, styled like a console readout.

- **CTX**: how full this session's context window is.
- **5H / 7D**: how much of your 5-hour and 7-day plan limits you have used, with a bar that turns amber at 75% and red at 90%, and a countdown to each reset.
- **FABLE** (and other per-model weekly limits): read from Anthropic's account usage endpoint with the session's own sign-in, refreshed every 5 minutes. A limit that resets at the same moment as 7D shares its chip and countdown.
- **TOK**: tokens this session has used since the mod loaded, plus the last turn's tokens.

In the desktop app the band is drawn as one picture with octagon frames; in a terminal it is a single text line. Run `/usage-meter` to hide or show it.

The plan name in the header's right corner is set in `hooks/register.tsx` (`PLAN`), since Claude Code does not tell mods which plan you are on.

## Install

At the prompt of a terminal session:

```
/plugin install usage-meter --marketplace whatsphone-creator/claude-usage-mod
```

Answer `y` to add the marketplace, then choose a scope.

From a shell:

```
claude plugin install usage-meter --marketplace whatsphone-creator/claude-usage-mod
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `whatsphone-creator/claude-usage-mod`, then Add plugin.

This repository is private: it installs only for people who can read it on GitHub and whose machine already has a git credential for github.com (an SSH key, or `gh auth login` then `gh auth setup-git`).
