import { describe, expect, test } from "bun:test"
import { htmlWithTitle } from "./web-ui"

describe("web-ui title override", () => {
  const page = (title: string) =>
    `<html><head><title>${title}</title><script id="oc-theme-preload-script">1</script></head></html>`

  test("replaces the title and escapes HTML", () => {
    expect(htmlWithTitle(page("OpenCode"), "prod <frontend> & co")).toBe(page("prod &lt;frontend&gt; &amp; co"))
  })

  test("keeps $ sequences in the title literal", () => {
    expect(htmlWithTitle(page("OpenCode"), "cost: $100 $$`")).toBe(page("cost: $100 $$`"))
  })

  test("unset, blank, and whitespace-only titles leave the body unchanged", () => {
    expect(htmlWithTitle(page("OpenCode"), undefined)).toBe(page("OpenCode"))
    expect(htmlWithTitle(page("OpenCode"), "")).toBe(page("OpenCode"))
    expect(htmlWithTitle(page("OpenCode"), "   ")).toBe(page("OpenCode"))
  })

  test("trims the configured title", () => {
    expect(htmlWithTitle(page("OpenCode"), "  host-vm3  ")).toBe(page("host-vm3"))
  })

  test("a body without a title block is left unchanged", () => {
    const body = "<html><head></head></html>"
    expect(htmlWithTitle(body, "any")).toBe(body)
  })
})
