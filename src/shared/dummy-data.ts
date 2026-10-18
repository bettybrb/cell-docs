/**
 * Generated, obviously-fake data for demos and tests. Nothing here refers to
 * real people, organisations or content.
 */

const WORDS = [
  "amber", "basalt", "cedar", "delta", "ember", "fjord", "garnet", "harbor",
  "indigo", "juniper", "kelp", "lagoon", "meadow", "nimbus", "orchid", "pebble",
  "quartz", "ripple", "sorrel", "tundra", "umber", "willow", "yarrow", "zephyr",
];

function pick(): string {
  return WORDS[Math.floor(Math.random() * WORDS.length)];
}

/** Short random suffix that keeps ids within the allowed character set. */
export function randomSuffix(): string {
  return crypto.randomUUID().slice(0, 8);
}

export function dummyWorkspaceId(): string {
  return `demo-${randomSuffix()}`;
}

export function dummyDocId(): string {
  return `${pick()}-${randomSuffix()}`;
}

export function dummyTitle(): string {
  const [a, b] = [pick(), pick()];
  return `${a[0].toUpperCase()}${a.slice(1)} ${b} notes`;
}

export function dummyBody(sentences = 3): string {
  return Array.from({ length: sentences }, () => {
    const words = Array.from({ length: 6 }, pick).join(" ");
    return `${words[0].toUpperCase()}${words.slice(1)}.`;
  }).join(" ");
}
