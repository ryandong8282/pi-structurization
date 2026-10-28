import type { SamplingComponentBinding, ValidationIssue } from "./contracts.js";

export function samplingComponentIdentity(component: Pick<SamplingComponentBinding, "key" | "role">): string {
  return `${component.key}\0${component.role}`;
}

export function validateSamplingComponents(
  components: readonly SamplingComponentBinding[],
  path: string,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();
  components.forEach((component, index) => {
    const componentPath = `${path}/${index}`;
    const identity = samplingComponentIdentity(component);
    if (seen.has(identity)) {
      issues.push({
        code: "sampling_component_duplicate",
        path: componentPath,
        message: "Sampling component key and role must be unique within one scope",
        details: {
          required_action: "Give this component a unique key or role in the same scope",
          key: component.key,
          role: component.role,
        },
      });
    }
    seen.add(identity);
    if (component.disposition === "present" && component.source_span_ids.length === 0) {
      issues.push({
        code: "sampling_component_present_unbound",
        path: `${componentPath}/source_span_ids`,
        message: "A present sampling component must bind at least one registered source span",
        details: {
          required_action: "Bind at least one registered source span, or mark the component absent/not_applicable",
        },
      });
    }
    if (component.disposition !== "present" && component.source_span_ids.length > 0) {
      issues.push({
        code: "sampling_component_absent_with_source",
        path: `${componentPath}/source_span_ids`,
        message: "An absent or not_applicable sampling component must not bind source spans",
        details: {
          required_action: "Clear source_span_ids, or set disposition=present if the spans are the component's evidence",
        },
      });
    }
  });
  return issues;
}

export function mergeSamplingComponents(
  shared: readonly SamplingComponentBinding[],
  branch: readonly SamplingComponentBinding[],
  path: string,
): { components: SamplingComponentBinding[]; issues: ValidationIssue[] } {
  const issues = [
    ...validateSamplingComponents(shared, `${path}/shared`),
    ...validateSamplingComponents(branch, `${path}/branch`),
  ];
  const effective = new Map(shared.map((component) => [samplingComponentIdentity(component), component]));
  branch.forEach((component) => {
    const identity = samplingComponentIdentity(component);
    const inherited = effective.get(identity);
    if (
      inherited?.disposition === "present"
      && component.disposition !== "present"
    ) {
      // Branch-local absent/not_applicable records that this branch adds no
      // narrower value. It never deletes an independently bound shared member.
      return;
    }
    effective.set(identity, component);
  });
  return { components: [...effective.values()], issues };
}
