/**
 * ModelWorkspaceModal, the multi-target model picker (main/helper/tool/tts/
 * embeddings), search + filter, toward the TUI's Model Workspace standard
 * (src/renderer/model-workspace.ts + src/input/model-picker.ts). Launched from
 * ProvidersView's "Browse Models" button. See src/lib/model-catalog.ts for the
 * full grounding on what's wire-honest here (price filter/group are real,
 * from providers.list()'s tier+pricing; the capability filter reads each model's
 * capability flags and renders disabled when a daemon sends none).
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Checkbox } from '../ui/Checkbox';
import { Input } from '../ui/Field';
import { Row, RowList } from '../ui/Row';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { PHONE_QUERY, useMediaQuery } from '../ui/overlay';
import { client as platformClient } from '../../lib/goodvibes';
import { formatError } from '../../lib/errors';
import { readPath } from '../../lib/object';
import { useToast } from '../../lib/toast';
import { EmptyState } from '../feedback/EmptyState';
import { ErrorState } from '../feedback/ErrorState';
import { SkeletonBlock } from '../feedback/SkeletonBlock';
import {
  buildTargetEnableEntry,
  buildTargetWriteEntries,
  configuredProviderIdsFromProvidersResponse,
  detectFamily,
  filterModels,
  groupModels,
  hasAnyCapabilityData,
  hasAnyTierData,
  MODEL_TARGETS,
  modelsFromProvidersResponse,
  providerIdsFromProvidersResponse,
  readTargetRouting,
  TARGET_LABELS,
  targetHasNoModelConcept,
  type CategoryFilter,
  type CatalogModel,
  type CapabilityFilter,
  type GroupByMode,
  type ModelTarget,
} from '../../lib/model-catalog';
import '../../styles/components/model-workspace.css';
import '../../styles/components/providers.css';

/** Re-read cadence and bound while the catalog is grouped by family and some families are missing. */
const FAMILY_POLL_MS = 5_000;
const FAMILY_POLL_LIMIT = 12;

/** "128k context", "1M context", or '' when the catalog reports none. */
function contextLabel(contextWindow: number | undefined): string {
  if (typeof contextWindow !== 'number' || !Number.isFinite(contextWindow) || contextWindow <= 0) return '';
  if (contextWindow >= 1_000_000) return `${Number((contextWindow / 1_000_000).toFixed(1))}M context`;
  if (contextWindow >= 1_000) return `${Math.round(contextWindow / 1_000)}k context`;
  return `${contextWindow} context`;
}

/** "$15 in / $75 out" per 1M tokens, or the tier word when only a tier is served. */
function priceLabel(model: CatalogModel): string {
  if (model.pricing) {
    return `$${model.pricing.inputPerMillionTokens} in / $${model.pricing.outputPerMillionTokens} out`;
  }
  return model.tier ?? '';
}

function ModelFigures({ model }: { model: CatalogModel }) {
  const context = contextLabel(model.contextWindow);
  const price = priceLabel(model);
  if (!context && !price) return null;
  return (
    <span className="model-workspace-figures">
      {context && <span>{context}</span>}
      {price && (
        <span title={model.pricing ? 'US dollars per 1M tokens' : undefined}>
          {price}
          {model.pricing && model.tier ? ` · ${model.tier}` : ''}
        </span>
      )}
    </span>
  );
}

export interface ModelWorkspaceModalProps {
  open: boolean;
  onClose: () => void;
}

export function ModelWorkspaceModal({ open, onClose }: ModelWorkspaceModalProps) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [target, setTarget] = useState<ModelTarget>('main');
  const [query, setQuery] = useState('');
  const [providerFilter, setProviderFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<CategoryFilter>('all');
  const [capabilityFilter, setCapabilityFilter] = useState<CapabilityFilter>('none');
  const [groupBy, setGroupBy] = useState<GroupByMode>('provider');
  const [availableOnly, setAvailableOnly] = useState(false);

  const providers = useQuery({
    queryKey: ['providers'],
    queryFn: () => platformClient.operator.providers.list(),
    enabled: open,
    // Families arrive as optional server enrichment; never block catalog access
    // on judgment. While grouped by family, re-read until every model has one,
    // for at most a minute (a daemon without family metadata never sends them).
    refetchInterval: (query) => open && groupBy === 'family'
      && query.state.dataUpdateCount < FAMILY_POLL_LIMIT
      && modelsFromProvidersResponse(query.state.data).some((model) => detectFamily(model) === undefined)
      ? FAMILY_POLL_MS
      : false,
  });
  const currentModel = useQuery({
    queryKey: ['models', 'current'],
    queryFn: () => platformClient.operator.models.current.get(),
    enabled: open,
  });
  const config = useQuery({
    queryKey: ['config'],
    queryFn: () => platformClient.operator.config.get(),
    enabled: open,
  });

  const allModels = useMemo(() => modelsFromProvidersResponse(providers.data), [providers.data]);
  const providerIds = useMemo(() => providerIdsFromProvidersResponse(providers.data), [providers.data]);
  const configuredProviderIds = useMemo(
    () => configuredProviderIdsFromProvidersResponse(providers.data),
    [providers.data],
  );
  const priceDataAvailable = useMemo(() => hasAnyTierData(allModels), [allModels]);
  const capabilityDataAvailable = useMemo(() => hasAnyCapabilityData(allModels), [allModels]);

  const routing = useMemo(
    () => readTargetRouting(target, config.data, readPath(currentModel.data, ['model']) as { registryKey?: string; provider?: string; id?: string } | null),
    [target, config.data, currentModel.data],
  );

  const filtered = useMemo(
    () =>
      filterModels(allModels, {
        query,
        provider: providerFilter || undefined,
        categoryFilter,
        capabilityFilter: capabilityDataAvailable ? capabilityFilter : 'none',
        availableOnly,
        configuredProviderIds,
      }),
    [allModels, query, providerFilter, categoryFilter, capabilityFilter, capabilityDataAvailable, availableOnly, configuredProviderIds],
  );

  const groups = useMemo(() => groupModels(filtered, groupBy), [filtered, groupBy]);

  const useModel = useMutation({
    mutationFn: async (model: CatalogModel) => {
      if (target === 'main') {
        return platformClient.operator.models.current.set(model.registryKey);
      }
      const entries = buildTargetWriteEntries(target, model.provider, model.id) ?? [];
      // A target's keys (e.g. helper.globalProvider + helper.globalModel + helper.enabled)
      // are one update: the daemon admits them together, so a refusal changes none.
      if (entries.length > 0) await platformClient.operator.config.setMany(entries);
      return { entries };
    },
    onSuccess: async (_data, model) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['config'] }),
        queryClient.invalidateQueries({ queryKey: ['models'] }),
        queryClient.invalidateQueries({ queryKey: ['providers'] }),
      ]);
      toast({ title: `${TARGET_LABELS[target]} updated`, description: model.label, tone: 'success' });
    },
    onError: (error: unknown) => {
      // Re-read so the dialog shows what the daemon holds now; the refusal says what, if anything, was saved.
      void queryClient.invalidateQueries({ queryKey: ['config'] });
      void queryClient.invalidateQueries({ queryKey: ['models'] });
      toast({ title: 'Model selection failed', description: formatError(error), tone: 'danger' });
    },
  });

  const toggleEnabled = useMutation({
    mutationFn: async (enabled: boolean) => {
      const entry = buildTargetEnableEntry(target, enabled);
      if (!entry) return;
      await platformClient.operator.config.set(entry[0], entry[1]);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['config'] });
    },
    onError: (error: unknown) => {
      toast({ title: 'Failed to update', description: formatError(error), tone: 'danger' });
    },
  });

  const isLoading = providers.isLoading || (target === 'main' && currentModel.isLoading) || (target !== 'main' && config.isLoading);
  const hasError = providers.isError || (target === 'main' && currentModel.isError) || (target !== 'main' && config.isError);
  const embeddingsMode = targetHasNoModelConcept(target);
  const enableEntry = buildTargetEnableEntry(target, true);

  const phone = useMediaQuery(PHONE_QUERY);
  return (
    <Dialog open={open} onClose={onClose} title="Model Workspace" size="wide">
      <div className="model-workspace-targets">
        {/* Five targets do not fit one segmented row at phone width; a select
            holds them without clipping. */}
        {phone ? (
          <Select<ModelTarget>
            aria-label="Model routing target"
            value={target}
            onChange={setTarget}
            options={MODEL_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))}
          />
        ) : (
          <Segmented<ModelTarget>
            label="Model routing target"
            value={target}
            onChange={setTarget}
            options={MODEL_TARGETS.map((t) => ({ value: t, label: TARGET_LABELS[t] }))}
          />
        )}
      </div>

      <div className="model-workspace-routing" aria-live="polite">
        {routing.unset ? (
          <span className="model-workspace-routing__note">
            {routing.label}: not configured{routing.configuredNote ? `: ${routing.configuredNote}` : ''}
          </span>
        ) : (
          <span className="model-workspace-routing__current">
            {routing.label}: <strong>{embeddingsMode ? routing.provider : `${routing.provider}:${routing.model}`}</strong>
            {routing.configuredNote ? ` (${routing.configuredNote})` : ''}
          </span>
        )}
        {enableEntry && (
          <Checkbox
            className="model-workspace-enable-toggle"
            checked={routing.enabled}
            disabled={toggleEnabled.isPending}
            onChange={(checked) => toggleEnabled.mutate(checked)}
          >
            Enabled
          </Checkbox>
        )}
      </div>

      <div className="model-workspace-filters">
        <Input
          className="model-workspace-search"
          type="text"
          inputMode="search"
          placeholder="Search models"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search models"
        />

        {!embeddingsMode && (
          <div className="model-workspace-filter-row">
            <div className="model-workspace-filter">
              <span className="model-workspace-filter__label" aria-hidden="true">Provider</span>
              <Select
                aria-label="Provider"
                value={providerFilter || 'all'}
                onChange={(next) => setProviderFilter(next === 'all' ? '' : next)}
                options={[{ value: 'all', label: 'All' }, ...providerIds.map((id) => ({ value: id, label: id }))]}
              />
            </div>

            <div className="model-workspace-filter" title={priceDataAvailable ? undefined : 'Not reported by this daemon'}>
              <span className="model-workspace-filter__label" aria-hidden="true">Price</span>
              <Select<CategoryFilter>
                aria-label="Price"
                value={categoryFilter}
                disabled={!priceDataAvailable}
                onChange={setCategoryFilter}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'free', label: 'Free' },
                  { value: 'paid', label: 'Paid' },
                  { value: 'subscription', label: 'Subscription' },
                ]}
              />
              {!priceDataAvailable && <small className="model-workspace-filter__note">Not reported by this daemon</small>}
            </div>

            <div className="model-workspace-filter" title={capabilityDataAvailable ? undefined : 'Not reported by this daemon'}>
              <span className="model-workspace-filter__label" aria-hidden="true">Capability</span>
              <Select<CapabilityFilter>
                aria-label="Capability"
                value={capabilityDataAvailable ? capabilityFilter : 'none'}
                disabled={!capabilityDataAvailable}
                onChange={setCapabilityFilter}
                options={[
                  { value: 'none', label: 'Any' },
                  { value: 'toolUse', label: 'Tool use' },
                  { value: 'reasoning', label: 'Reasoning' },
                  { value: 'multimodal', label: 'Images' },
                ]}
              />
              {!capabilityDataAvailable && <small className="model-workspace-filter__note">Not reported by this daemon</small>}
            </div>

            <div className="model-workspace-filter">
              <span className="model-workspace-filter__label" aria-hidden="true">Group</span>
              <Select<GroupByMode>
                aria-label="Group"
                value={groupBy}
                onChange={setGroupBy}
                options={[
                  { value: 'provider', label: 'Provider' },
                  { value: 'family', label: 'Family' },
                  { value: 'pricingTier', label: 'Pricing tier' },
                ]}
              />
            </div>

            <Checkbox className="model-workspace-available-only" checked={availableOnly} onChange={setAvailableOnly}>
              Available only
            </Checkbox>
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="model-workspace-skeleton" aria-label="Loading model workspace" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonBlock key={i} variant="block" height={48} />
          ))}
        </div>
      ) : hasError ? (
        <ErrorState
          error={providers.error ?? currentModel.error ?? config.error}
          title="Failed to load the model workspace"
          onRetry={() => {
            void providers.refetch();
            void currentModel.refetch();
            void config.refetch();
          }}
        />
      ) : embeddingsMode ? (
        providerIds.length === 0 ? (
          <EmptyState title="No providers" description="No providers are registered with the daemon." />
        ) : (
          <RowList aria-label="Embedding providers">
            {providerIds.map((id) => {
              const isCurrent = id === routing.provider;
              return (
                <Row
                  key={id}
                  className="model-workspace-row"
                  selected={isCurrent}
                  title={id}
                  trailing={
                    <Button
                      size="sm"
                      variant={isCurrent ? 'ghost' : 'secondary'}
                      disabled={isCurrent || useModel.isPending}
                      onClick={() => useModel.mutate({ id: '', registryKey: '', provider: id, label: id })}
                    >
                      {isCurrent ? 'Current' : 'Use'}
                    </Button>
                  }
                />
              );
            })}
          </RowList>
        )
      ) : filtered.length === 0 ? (
        <EmptyState title="No models" description="No models match the current search/filter." />
      ) : (
        <div className="model-workspace-groups">
          {groups.map((group) => (
            <section key={group.key} className="model-workspace-group" aria-label={group.label}>
              {groups.length > 1 && <h3 className="model-workspace-group__title">{group.label}</h3>}
              <RowList aria-label={`Models in ${group.label}`}>
                {group.models.map((model) => {
                  const isCurrent = model.registryKey === routing.model || (target === 'main' && `${model.provider}:${model.id}` === `${routing.provider}:${routing.model}`);
                  return (
                    <Row
                      key={model.registryKey}
                      className="model-workspace-row"
                      selected={isCurrent}
                      title={model.label}
                      meta={<span className="model-workspace-row__key">{model.registryKey}</span>}
                      trailing={
                        <>
                          <ModelFigures model={model} />
                          <Button
                            size="sm"
                            variant={isCurrent ? 'ghost' : 'secondary'}
                            disabled={isCurrent || useModel.isPending}
                            onClick={() => useModel.mutate(model)}
                          >
                            {isCurrent ? 'Current' : 'Use'}
                          </Button>
                        </>
                      }
                    />
                  );
                })}
              </RowList>
            </section>
          ))}
        </div>
      )}
    </Dialog>
  );
}
