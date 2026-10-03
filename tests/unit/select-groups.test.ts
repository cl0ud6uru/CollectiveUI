import { createElement, isValidElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { Select } from "@/components/ui/select";

describe("Select option-group contract", () => {
  it("keeps disabled groups and individual disabled options unselectable", () => {
    const tree = Select({ children: [
      createElement("optgroup", { key: "off", label: "Unavailable", disabled: true }, createElement("option", { value: "group-disabled" }, "One")),
      createElement("optgroup", { key: "on", label: "Available" }, createElement("option", { value: "enabled" }, "Two"), createElement("option", { value: "item-disabled", disabled: true }, "Three")),
    ] });
    const options = new Map<string, boolean>();
    function visit(node: ReactNode) {
      if (Array.isArray(node)) return node.forEach(visit);
      if (!isValidElement<{ children?: ReactNode; "data-value"?: string; disabled?: boolean }>(node)) return;
      if (node.props["data-value"]) options.set(node.props["data-value"], !!node.props.disabled);
      visit(node.props.children);
    }
    visit(tree);
    expect(options).toEqual(new Map([["group-disabled", true], ["enabled", false], ["item-disabled", true]]));
  });
});
