import { stableHash } from "../shared/ids";
import type { TranslationRecord } from "../shared/types";

export type TranslationBlock = {
  key: string;
  text: string;
};

export type TranslationBatchOptions = {
  firstBatchSize?: number;
  batchSize?: number;
};

export function translationRecordId(sourceId: string, text: string): string {
  return `tr_${stableHash(`${sourceId}\n${text}`)}`;
}

export function translationBlockKey(sourceId: string, text: string): string {
  return stableHash(`${sourceId}\n${text}`);
}

export function createTranslationRecord(input: {
  sourceId: string;
  text: string;
  translation: string;
  now?: string;
}): TranslationRecord {
  const now = input.now ?? new Date().toISOString();
  const textHash = translationBlockKey(input.sourceId, input.text);
  return {
    id: translationRecordId(input.sourceId, input.text),
    sourceId: input.sourceId,
    textHash,
    text: input.text,
    translation: input.translation,
    createdAt: now,
    updatedAt: now
  };
}

export function isUsableTranslationText(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  return Boolean(text) && text !== "[object Object]";
}

export function uniqueTranslationBlocks<T extends TranslationBlock>(blocks: T[]): T[] {
  return blocks.filter((item, index, all) => all.findIndex((candidate) => candidate.key === item.key) === index);
}

export function createTranslationBatches<T extends TranslationBlock>(
  blocks: T[],
  cachedKeys: Set<string>,
  options: TranslationBatchOptions = {}
): T[][] {
  const firstBatchSize = Math.max(1, options.firstBatchSize ?? 1);
  const batchSize = Math.max(1, options.batchSize ?? 3);
  const pending = blocks.filter((block) => !cachedKeys.has(block.key));
  const batches: T[][] = [];

  if (pending.length === 0) {
    return batches;
  }

  batches.push(pending.slice(0, firstBatchSize));
  for (let index = firstBatchSize; index < pending.length; index += batchSize) {
    batches.push(pending.slice(index, index + batchSize));
  }

  return batches;
}
