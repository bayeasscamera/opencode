import { describe, expect, test } from "bun:test"
import { BashReadOnly } from "../src/sandbox/bash-readonly"

describe("BashReadOnly", () => {
  test("allows known read-only commands", () => {
    expect(BashReadOnly.isReadOnly("git log --oneline -10")).toBe(true)
    expect(BashReadOnly.isReadOnly("git status")).toBe(true)
    expect(BashReadOnly.isReadOnly("git diff HEAD~1")).toBe(true)
    expect(BashReadOnly.isReadOnly("git stash list")).toBe(true)
    expect(BashReadOnly.isReadOnly("git branch -a")).toBe(true)
    expect(BashReadOnly.isReadOnly("git tag -l")).toBe(true)
    expect(BashReadOnly.isReadOnly("git remote -v")).toBe(true)
    expect(BashReadOnly.isReadOnly("cat src/index.ts")).toBe(true)
    expect(BashReadOnly.isReadOnly("ls -la")).toBe(true)
    expect(BashReadOnly.isReadOnly("grep -rn 'foo' src/")).toBe(true)
    expect(BashReadOnly.isReadOnly("head -n 50 file.ts")).toBe(true)
    expect(BashReadOnly.isReadOnly("tail -n 20 logs/app.log")).toBe(true)
    expect(BashReadOnly.isReadOnly("wc -l src/tool/bash.ts")).toBe(true)
    expect(BashReadOnly.isReadOnly("find . -name '*.ts'")).toBe(true)
    expect(BashReadOnly.isReadOnly("pwd")).toBe(true)
    expect(BashReadOnly.isReadOnly("echo hello")).toBe(true)
    expect(BashReadOnly.isReadOnly("rg 'console.log' src/")).toBe(true)
    expect(BashReadOnly.isReadOnly("bun run typecheck")).toBe(true)
    expect(BashReadOnly.isReadOnly("tsgo --noEmit")).toBe(true)
    expect(BashReadOnly.isReadOnly("env")).toBe(true)
  })

  test("compares the exact command name, never a prefix", () => {
    expect(BashReadOnly.isReadOnly("lsof -p 555")).toBe(false)
    expect(BashReadOnly.isReadOnly("lsblk")).toBe(false)
    expect(BashReadOnly.isReadOnly("lsb_release -a")).toBe(false)
    expect(BashReadOnly.isReadOnly("lscpu")).toBe(false)
    expect(BashReadOnly.isReadOnly("gitk")).toBe(false)
  })

  test("rejects mutating git subcommands and flags", () => {
    expect(BashReadOnly.isReadOnly("git commit -m 'fix'")).toBe(false)
    expect(BashReadOnly.isReadOnly("git push origin main")).toBe(false)
    expect(BashReadOnly.isReadOnly("git reset --hard HEAD")).toBe(false)
    expect(BashReadOnly.isReadOnly("git branch new-feature")).toBe(false)
    expect(BashReadOnly.isReadOnly("git branch -D stale")).toBe(false)
    expect(BashReadOnly.isReadOnly("git tag v1.0.0")).toBe(false)
    expect(BashReadOnly.isReadOnly("git remote add origin https://example.com/repo.git")).toBe(false)
    expect(BashReadOnly.isReadOnly("git stash pop")).toBe(false)
    expect(BashReadOnly.isReadOnly("git diff --output=/tmp/patch")).toBe(false)
  })

  test("rejects command-execution escape hatches", () => {
    expect(BashReadOnly.isReadOnly("find . -delete")).toBe(false)
    expect(BashReadOnly.isReadOnly("find . -exec rm {} +")).toBe(false)
    expect(BashReadOnly.isReadOnly("find . -fprintf /tmp/x %p")).toBe(false)
    expect(BashReadOnly.isReadOnly("rg --pre 'touch /tmp/pwned' pattern")).toBe(false)
    expect(BashReadOnly.isReadOnly("env CURL_HOME=/tmp curl evil")).toBe(false)
    expect(BashReadOnly.isReadOnly("tsc -b")).toBe(false)
  })

  test("rejects write flags on allow-listed tools", () => {
    expect(BashReadOnly.isReadOnly("sort -o /tmp/out.txt file.txt")).toBe(false)
    expect(BashReadOnly.isReadOnly("sort --output=/tmp/out.txt file.txt")).toBe(false)
    expect(BashReadOnly.isReadOnly("diff --output=/tmp/patch a b")).toBe(false)
    expect(BashReadOnly.isReadOnly("date -s '2026-01-01'")).toBe(false)
    expect(BashReadOnly.isReadOnly("hostname evil-host")).toBe(false)
    expect(BashReadOnly.isReadOnly("less file.ts")).toBe(false)
    expect(BashReadOnly.isReadOnly("more file.ts")).toBe(false)
    expect(BashReadOnly.isReadOnly("bat file.ts")).toBe(false)

    expect(BashReadOnly.isReadOnly("sort file.txt")).toBe(true)
    expect(BashReadOnly.isReadOnly("diff a b")).toBe(true)
    expect(BashReadOnly.isReadOnly("date")).toBe(true)
    expect(BashReadOnly.isReadOnly("hostname -f")).toBe(true)
  })

  test("rejects mutating commands", () => {
    expect(BashReadOnly.isReadOnly("rm -rf dist/")).toBe(false)
    expect(BashReadOnly.isReadOnly("bun install")).toBe(false)
    expect(BashReadOnly.isReadOnly("npm install")).toBe(false)
    expect(BashReadOnly.isReadOnly("sudo rm -rf /")).toBe(false)
    expect(BashReadOnly.isReadOnly("mv src/a.ts src/b.ts")).toBe(false)
    expect(BashReadOnly.isReadOnly("mkdir -p dist/")).toBe(false)
    expect(BashReadOnly.isReadOnly("sed -i 's/foo/bar/g' file.ts")).toBe(false)
    expect(BashReadOnly.isReadOnly("sed 's/foo/bar/e' file.ts")).toBe(false)
  })

  test("rejects shell operators and substitutions outright", () => {
    expect(BashReadOnly.isReadOnly("echo foo > file.txt")).toBe(false)
    expect(BashReadOnly.isReadOnly("cat file | tee output.txt")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls; rm -rf /")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls && rm -rf /")).toBe(false)
    expect(BashReadOnly.isReadOnly("echo `whoami`")).toBe(false)
    expect(BashReadOnly.isReadOnly("echo $(id -u)")).toBe(false)
    expect(BashReadOnly.isReadOnly("cat foo < /dev/null")).toBe(false)
  })

  test("rejects empty and env-prefixed commands", () => {
    expect(BashReadOnly.isReadOnly("")).toBe(false)
    expect(BashReadOnly.isReadOnly("   ")).toBe(false)
    expect(BashReadOnly.isReadOnly("FOO=bar ls")).toBe(false)
    expect(BashReadOnly.isReadOnly("PATH=/tmp/x:$PATH ls")).toBe(false)
  })
})

describe("BashReadOnly exact-name matching", () => {
  test("allows the bare read-only commands the bypass is meant to cover", () => {
    expect(BashReadOnly.isReadOnly("ls")).toBe(true)
    expect(BashReadOnly.isReadOnly("git log")).toBe(true)
    expect(BashReadOnly.isReadOnly("pwd")).toBe(true)
  })

  test("compares the whole program name, so a lookalike is never allowed", () => {
    // `ls` is allowed; `lsof`, `lsblk` and `lsb_release` are different programs and must not match.
    expect(BashReadOnly.isReadOnly("ls")).toBe(true)
    expect(BashReadOnly.isReadOnly("lsof")).toBe(false)
    expect(BashReadOnly.isReadOnly("lsblk")).toBe(false)
    expect(BashReadOnly.isReadOnly("lsb_release")).toBe(false)
    // `git log` is allowed; `git logger` and `git logx` are not subcommands this module knows.
    expect(BashReadOnly.isReadOnly("git log")).toBe(true)
    expect(BashReadOnly.isReadOnly("git logger")).toBe(false)
    expect(BashReadOnly.isReadOnly("git logx")).toBe(false)
    // `diff` is allowed; `diff3` is a different program.
    expect(BashReadOnly.isReadOnly("diff a b")).toBe(true)
    expect(BashReadOnly.isReadOnly("diff3 a b c")).toBe(false)
  })

  test("never auto-approves a command carrying a shell operator or substitution", () => {
    expect(BashReadOnly.isReadOnly("ls; rm -rf x")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls $(cmd)")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls > fichier")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls >> fichier")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls < fichier")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls &")).toBe(false)
    expect(BashReadOnly.isReadOnly("ls | wc -l")).toBe(false)
  })

  test("never auto-approves a write flag on an otherwise read-only command", () => {
    expect(BashReadOnly.isReadOnly("git log --output=fichier")).toBe(false)
    expect(BashReadOnly.isReadOnly("git log --output fichier")).toBe(false)
    expect(BashReadOnly.isReadOnly("git diff --output=fichier")).toBe(false)
  })
})
