---
name: Standalone npm lockfiles
description: Keeping a portable npm package independent from the surrounding pnpm workspace.
---

For a standalone npm package nested inside this pnpm workspace, generate `package-lock.json` from an isolated temporary directory containing only its `package.json`, then copy the resulting lockfile into the package. npm can otherwise follow the workspace's symlinked `node_modules` and write local `.pnpm` paths into the lockfile.

**Why:** the package must install from its own folder after download, without relying on this workspace's pnpm store.

**How to apply:** use this when a nested Node project must support ordinary `npm install` or `npm ci` independently of the monorepo.
