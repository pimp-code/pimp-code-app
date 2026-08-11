export const CERTIFIED_PLANNING_ADAPTERS = {
  "migrate-to-vite": {
    name: "migrate-to-vite",
    packageDigests: [
      "8e07da42db0fbfd1b706c9675982fdd4d6d4eb1715daa8370e754e6a0a11d921",
    ],
  },
  "upgrade-react-router-to-v8": {
    name: "upgrade-react-router-to-v8",
    packageDigests: [
      "264eb58ae180c4771edf42625fa923c497936cef8babd4554f1433937f8ef022",
    ],
  },
} as const;

export const SUPPORTED_PLANNING_SKILL_NAMES = [
  "migrate-to-vite",
  "upgrade-react-router-to-v8",
] as const;

export type PlanningSkillName = (typeof SUPPORTED_PLANNING_SKILL_NAMES)[number];

export function isPlanningSkillSupported(name: string): name is PlanningSkillName {
  return (SUPPORTED_PLANNING_SKILL_NAMES as readonly string[]).includes(name);
}

export function isCertifiedPlanningSkillIdentity(
  name: string,
  packageDigest: string,
): name is PlanningSkillName {
  if (!isPlanningSkillSupported(name)) return false;
  const certification = CERTIFIED_PLANNING_ADAPTERS[name];
  return (certification.packageDigests as readonly string[]).includes(packageDigest);
}

export function assertCertifiedPlanningSkillIdentity(
  name: string,
  packageDigest: string,
): asserts name is PlanningSkillName {
  if (!isCertifiedPlanningSkillIdentity(name, packageDigest)) {
    throw new Error(
      `Skill package ${name || "<unnamed>"}@${packageDigest || "<missing-digest>"} is not certified for planning`,
    );
  }
}
