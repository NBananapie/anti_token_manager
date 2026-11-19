import React from 'react';
import { getModelColor, splitModelTier } from '../types';

interface Props {
  model: string;
  count?: number;
  title?: string;
  compact?: boolean;
}

export default function ModelBadge({ model, count, title, compact }: Props) {
  const { base, tier, tone } = splitModelTier(model);
  const color = getModelColor(model);

  return (
    <span className={`model-badge ${compact ? 'compact' : ''}`} title={title || model}>
      <span className="model-badge-dot" style={{ backgroundColor: color }} aria-hidden="true" />
      <span className="model-badge-base">{base}</span>
      {tier && <span className={`tier-pill ${tone}`}>{tier}</span>}
      {count != null && count > 0 && <span className="model-badge-count">×{count}</span>}
    </span>
  );
}
