import type { Category, EnergyType, Rarity, Stage } from '../enums.js';

export type Language = string; // validated against source.languages at startup

export interface CardSource {
  readonly id: string;
  readonly languages: readonly Language[];
  /** Cheap. One fingerprint per set, covering all requested langs. */
  listSets(langs: Language[], signal: AbortSignal): Promise<SetInfo[]>;
  /** Expensive. All cards of one set, all requested langs. All or throw. */
  fetchSet(setId: string, langs: Language[], signal: AbortSignal): Promise<Card[]>;
}

export interface SetInfo {
  id: string; // 'A1'
  fingerprint: string; // changes when set content changes (best effort)
  names: Partial<Record<Language, string>>;
}

export interface Card {
  id: string; // 'A1-036', stable across langs
  setId: string;
  category: Category;
  type: EnergyType | null; // Pocket Pokémon have one type
  stage: Stage | null;
  rarity: Rarity;
  hp: number | null;
  texts: Partial<Record<Language, CardText>>; // only langs that exist for this card
}

export interface CardText {
  name: string;
  effect: string | null; // trainer effect, or "AbilityName: ability effect"
  attacks: Attack[];
  image: string | null;
}

export interface Attack {
  name: string;
  cost: EnergyType[];
  damage: string | null;
  effect: string | null;
}
