import {
  MIGRATE_TO_VITE_PLAN_SCHEMA_VERSION,
  MIGRATE_TO_VITE_PLAN_V1_SCHEMA,
  buildMigrateToVitePlanPrompt,
  renderMigrateToVitePlanMarkdown,
  validateMigrateToViteProviderPlanV1,
  type MigrateToVitePlanV1,
} from "./migrate-to-vite-plan.js";
import {
  MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION,
  UPGRADE_REACT_ROUTER_TO_V8_PREFLIGHT_SCHEMA_VERSION,
  assertMigrateToVitePreflightIntegrity,
  assertUpgradeReactRouterToV8PreflightIntegrity,
  type MigrateToVitePreflight,
  type UpgradeReactRouterToV8Preflight,
} from "./preflight.js";
import {
  UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION,
  UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA,
  buildUpgradeReactRouterToV8PlanPrompt,
  renderUpgradeReactRouterToV8PlanMarkdown,
  validateUpgradeReactRouterToV8ProviderPlanV1,
  type UpgradeReactRouterToV8PlanV1,
} from "./upgrade-react-router-to-v8-plan.js";
import {
  type PlanningSkillName,
} from "./planning-certification.js";
export {
  CERTIFIED_PLANNING_ADAPTERS,
  SUPPORTED_PLANNING_SKILL_NAMES,
  assertCertifiedPlanningSkillIdentity,
  isCertifiedPlanningSkillIdentity,
  isPlanningSkillSupported,
  type PlanningSkillName,
} from "./planning-certification.js";
export type PlanningPreflight = MigrateToVitePreflight | UpgradeReactRouterToV8Preflight;
export type PlanningPlan = MigrateToVitePlanV1 | UpgradeReactRouterToV8PlanV1;

export interface BoundPlanningAdapter {
  skillName: PlanningSkillName;
  outputSchema: Readonly<Record<string, unknown>>;
  buildPrompt(userGoal?: string): string;
  validate(value: unknown): PlanningPlan;
  render(plan: PlanningPlan): string;
}

export function assertPlanningPreflightIntegrity(preflight: PlanningPreflight): void {
  if (
    preflight.skill.name === "migrate-to-vite" &&
    preflight.schemaVersion === MIGRATE_TO_VITE_PREFLIGHT_SCHEMA_VERSION
  ) {
    assertMigrateToVitePreflightIntegrity(preflight);
    return;
  }
  if (
    preflight.skill.name === "upgrade-react-router-to-v8" &&
    preflight.schemaVersion === UPGRADE_REACT_ROUTER_TO_V8_PREFLIGHT_SCHEMA_VERSION
  ) {
    assertUpgradeReactRouterToV8PreflightIntegrity(preflight);
    return;
  }
  throw new Error("Unsupported planning preflight adapter");
}

export function getPlanningAdapter(preflight: PlanningPreflight): BoundPlanningAdapter {
  assertPlanningPreflightIntegrity(preflight);
  if (preflight.skill.name === "migrate-to-vite") {
    const migratePreflight = preflight as MigrateToVitePreflight;
    return {
      skillName: "migrate-to-vite",
      outputSchema: MIGRATE_TO_VITE_PLAN_V1_SCHEMA,
      buildPrompt: (userGoal) => buildMigrateToVitePlanPrompt({
        preflight: migratePreflight,
        ...(userGoal ? { userGoal } : {}),
      }),
      validate: (value) => validateMigrateToViteProviderPlanV1(value, migratePreflight),
      render: (plan) => {
        if (plan.schemaVersion !== MIGRATE_TO_VITE_PLAN_SCHEMA_VERSION) {
          throw new Error("Plan does not match the migrate-to-vite adapter");
        }
        return renderMigrateToVitePlanMarkdown(plan, migratePreflight);
      },
    };
  }

  const routerPreflight = preflight as UpgradeReactRouterToV8Preflight;
  return {
    skillName: "upgrade-react-router-to-v8",
    outputSchema: UPGRADE_REACT_ROUTER_TO_V8_PLAN_V1_SCHEMA,
    buildPrompt: (userGoal) => buildUpgradeReactRouterToV8PlanPrompt({
      preflight: routerPreflight,
      ...(userGoal ? { userGoal } : {}),
    }),
    validate: (value) => validateUpgradeReactRouterToV8ProviderPlanV1(value, routerPreflight),
    render: (plan) => {
      if (plan.schemaVersion !== UPGRADE_REACT_ROUTER_TO_V8_PLAN_SCHEMA_VERSION) {
        throw new Error("Plan does not match the upgrade-react-router-to-v8 adapter");
      }
      return renderUpgradeReactRouterToV8PlanMarkdown(plan, routerPreflight);
    },
  };
}
