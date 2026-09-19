export enum EnergyType {
  Grass = 'Grass',
  Fire = 'Fire',
  Water = 'Water',
  Lightning = 'Lightning',
  Psychic = 'Psychic',
  Fighting = 'Fighting',
  Darkness = 'Darkness',
  Metal = 'Metal',
  Dragon = 'Dragon',
  Colorless = 'Colorless',
}

export enum Stage {
  Basic = 'Basic',
  Stage1 = 'Stage1',
  Stage2 = 'Stage2',
}

export enum Rarity {
  OneDiamond = 'OneDiamond',
  TwoDiamond = 'TwoDiamond',
  ThreeDiamond = 'ThreeDiamond',
  FourDiamond = 'FourDiamond',
  OneStar = 'OneStar',
  TwoStar = 'TwoStar',
  ThreeStar = 'ThreeStar',
  OneShiny = 'OneShiny',
  TwoShiny = 'TwoShiny',
  Crown = 'Crown',
  None = 'None', // promos
}

export enum Category {
  Pokemon = 'Pokemon',
  Item = 'Item',
  Supporter = 'Supporter',
  Tool = 'Tool',
  Stadium = 'Stadium',
}

export enum Transport {
  Stdio = 'stdio',
  Http = 'http',
}

export enum EmbeddingProvider {
  OpenAI = 'openai',
  Compatible = 'compatible',
}

export enum EmbeddingKind {
  Effect = 'effect',
  Attack = 'attack',
}

/** Enum values as non-empty tuple, the shape drizzle `text({ enum })` wants. */
export const values = <T extends string>(e: Record<string, T>) => Object.values(e) as [T, ...T[]];

/** Value of `e` whose value equals `s`, else undefined. */
export const parseEnum = <T extends string>(e: Record<string, T>, s: unknown): T | undefined =>
  Object.values(e).find((v) => v === s);
