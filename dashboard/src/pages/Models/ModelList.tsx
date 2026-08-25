import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Content,
  Button,
  Spinner,
  Alert,
  AlertVariant,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
  ToolbarFilter,
  ToolbarGroup,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  EmptyState,
  EmptyStateBody,
  EmptyStateActions,
  EmptyStateFooter,
  Select,
  SelectOption,
  MenuToggle,
  type MenuToggleElement,
  Dropdown,
  DropdownItem,
  DropdownList,
  Pagination,
  Progress,
  ProgressSize,
  Checkbox,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td, type ThProps } from '@patternfly/react-table';
import { EllipsisVIcon, LockIcon, CubesIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import {
  useModels,
  useSleepModel,
  useWakeModel,
  useDeleteModel,
  useStopModel,
  useStartModel,
  useAddInstance,
} from '../../hooks/useModels';
import type { ModelInfo } from '../../api/client';
import { StateLabel } from '../../components/StateLabel';
import { formatBytes, formatRelativeTime } from '../../utils/format';
import { useAuth } from '../../contexts/AuthContext';

type SortField = 'modelName' | 'state' | 'currentMemory' | 'lastInferenceAt';
type SortDirection = 'asc' | 'desc';

const STATE_SORT_ORDER: Record<ModelLifecycleState, number> = {
  [ModelLifecycleState.ACTIVE]: 0,
  [ModelLifecycleState.STARTING]: 1,
  [ModelLifecycleState.PENDING]: 2,
  [ModelLifecycleState.DRAINING]: 3,
  [ModelLifecycleState.SLEEPING]: 4,
  [ModelLifecycleState.STOPPING]: 5,
  [ModelLifecycleState.STOPPED]: 6,
  [ModelLifecycleState.ERROR]: 7,
};

// Column order: [select?], modelName, state, runnerType, worker, instances, memory,
// lastInference, pinned, [actions?]. The "instances" column (#120) sits between worker and
// memory, shifting currentMemory/lastInferenceAt by one from their pre-#120 indices.
const SORT_COLUMN_INDEX: Record<SortField, number> = {
  modelName: 1,
  state: 2,
  currentMemory: 6,
  lastInferenceAt: 7,
};

const ALL_STATES: ModelLifecycleState[] = [
  ModelLifecycleState.PENDING,
  ModelLifecycleState.STARTING,
  ModelLifecycleState.ACTIVE,
  ModelLifecycleState.DRAINING,
  ModelLifecycleState.SLEEPING,
  ModelLifecycleState.STOPPING,
  ModelLifecycleState.STOPPED,
  ModelLifecycleState.ERROR,
];

const STATE_LOCALE_KEYS: Record<ModelLifecycleState, string> = {
  [ModelLifecycleState.ACTIVE]: 'common:status.active',
  [ModelLifecycleState.SLEEPING]: 'common:status.sleeping',
  [ModelLifecycleState.PENDING]: 'common:status.pending',
  [ModelLifecycleState.STARTING]: 'common:status.starting',
  [ModelLifecycleState.STOPPING]: 'common:status.stopping',
  [ModelLifecycleState.STOPPED]: 'common:status.stopped',
  [ModelLifecycleState.DRAINING]: 'common:status.draining',
  [ModelLifecycleState.ERROR]: 'common:status.error',
};

const DEFAULT_PAGE_SIZE = 20;

/** Return progress bar colour based on current/required ratio */
function getMemoryVariant(ratio: number): 'success' | 'warning' | 'danger' {
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.8) return 'warning';
  return 'success';
}

export function ModelList() {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { isAdmin } = useAuth();
  const { data: models, isLoading, error } = useModels();
  const sleepModel = useSleepModel();
  const wakeModel = useWakeModel();
  const deleteModel = useDeleteModel();
  const stopModel = useStopModel();
  const startModel = useStartModel();
  const addInstance = useAddInstance();

  // Sorting
  const [sortField, setSortField] = useState<SortField>('modelName');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // State filter — initialise from URL search params (e.g. ?state=ACTIVE&state=SLEEPING)
  const [stateFilterOpen, setStateFilterOpen] = useState(false);
  const [selectedStates, setSelectedStates] = useState<string[]>(() =>
    searchParams
      .getAll('state')
      .filter((s): s is ModelLifecycleState => ALL_STATES.includes(s as ModelLifecycleState)),
  );

  // Runner-type filter
  const [runnerFilterOpen, setRunnerFilterOpen] = useState(false);
  const [selectedRunners, setSelectedRunners] = useState<string[]>([]);

  // Pagination
  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  // Bulk selection
  const [selectedModelNames, setSelectedModelNames] = useState<Set<string>>(new Set());

  // Bulk action modals
  const [bulkSleepOpen, setBulkSleepOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // Kebab menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Modals
  const [sleepConfirmModel, setSleepConfirmModel] = useState<ModelInfo | null>(null);
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<ModelInfo | null>(null);
  const [stopConfirmModel, setStopConfirmModel] = useState<ModelInfo | null>(null);

  // Mutation error
  const [mutationError, setMutationError] = useState<string | null>(null);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('asc');
    }
  };

  const getSortParams = (field: SortField): ThProps['sort'] => {
    const columnIndex = SORT_COLUMN_INDEX[field];
    return {
      sortBy: {
        index: SORT_COLUMN_INDEX[sortField],
        direction: sortDir,
      },
      onSort: () => handleSort(field),
      columnIndex,
    };
  };

  const onStateFilterSelect = (value: string) => {
    setSelectedStates((prev) =>
      prev.includes(value) ? prev.filter((s) => s !== value) : [...prev, value],
    );
    setCurrentPage(1);
  };

  const onRunnerFilterSelect = (value: string) => {
    setSelectedRunners((prev) =>
      prev.includes(value) ? prev.filter((r) => r !== value) : [...prev, value],
    );
    setCurrentPage(1);
  };

  // Unique runner types from all models
  const allRunnerTypes = [...new Set((models ?? []).map((m) => m.runnerType))].sort();

  const filteredAndSorted = (models ?? [])
    .filter((m) => selectedStates.length === 0 || selectedStates.includes(m.state))
    .filter((m) => selectedRunners.length === 0 || selectedRunners.includes(m.runnerType))
    .sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'modelName':
          // Sorts on the unique modelName (routing key), not displayName — displayName is
          // presentation-only and isn't guaranteed unique or present.
          cmp = a.modelName.localeCompare(b.modelName);
          break;
        case 'state':
          cmp = STATE_SORT_ORDER[a.state] - STATE_SORT_ORDER[b.state];
          break;
        case 'currentMemory':
          cmp = (a.currentMemory ?? -1) - (b.currentMemory ?? -1);
          break;
        case 'lastInferenceAt': {
          const aTime = a.lastInferenceAt ? new Date(a.lastInferenceAt).getTime() : 0;
          const bTime = b.lastInferenceAt ? new Date(b.lastInferenceAt).getTime() : 0;
          cmp = aTime - bTime;
          break;
        }
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

  // Pagination slice
  const totalItems = filteredAndSorted.length;
  const paginatedModels = filteredAndSorted.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  // Bulk selection helpers
  const pageModelNames = paginatedModels.map((m) => m.modelName);
  const allPageSelected =
    pageModelNames.length > 0 && pageModelNames.every((n) => selectedModelNames.has(n));
  const somePageSelected = pageModelNames.some((n) => selectedModelNames.has(n));

  const toggleSelectAll = () => {
    if (allPageSelected) {
      setSelectedModelNames((prev) => {
        const next = new Set(prev);
        pageModelNames.forEach((n) => next.delete(n));
        return next;
      });
    } else {
      setSelectedModelNames((prev) => {
        const next = new Set(prev);
        pageModelNames.forEach((n) => next.add(n));
        return next;
      });
    }
  };

  const toggleSelectModel = (modelName: string) => {
    setSelectedModelNames((prev) => {
      const next = new Set(prev);
      if (next.has(modelName)) {
        next.delete(modelName);
      } else {
        next.add(modelName);
      }
      return next;
    });
  };

  const selectedCount = selectedModelNames.size;

  const handleSleepConfirm = () => {
    if (!sleepConfirmModel) return;
    setMutationError(null);
    sleepModel.mutate(sleepConfirmModel.modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Sleep failed'),
      onSettled: () => setSleepConfirmModel(null),
    });
  };

  const handleWake = (model: ModelInfo) => {
    setMutationError(null);
    wakeModel.mutate(model.modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Wake failed'),
    });
  };

  const handleDeleteConfirm = () => {
    if (!deleteConfirmModel) return;
    setMutationError(null);
    deleteModel.mutate(deleteConfirmModel.modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Delete failed'),
      onSettled: () => setDeleteConfirmModel(null),
    });
  };

  const handleStart = (model: ModelInfo) => {
    setMutationError(null);
    startModel.mutate(model.modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Start failed'),
    });
  };

  const handleStopConfirm = () => {
    if (!stopConfirmModel) return;
    setMutationError(null);
    stopModel.mutate(stopConfirmModel.modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Stop failed'),
      onSettled: () => setStopConfirmModel(null),
    });
  };

  const handleAddInstance = (model: ModelInfo) => {
    setMutationError(null);
    addInstance.mutate(model.modelName, {
      onError: (err) =>
        setMutationError(err instanceof Error ? err.message : 'Add instance failed'),
    });
  };

  // Bulk sleep: sleep all selected ACTIVE models
  const handleBulkSleep = () => {
    const activeSelected = (models ?? []).filter(
      (m) => selectedModelNames.has(m.modelName) && m.state === ModelLifecycleState.ACTIVE,
    );
    setMutationError(null);
    const promises = activeSelected.map((m) =>
      sleepModel.mutateAsync(m.modelName).catch((err: unknown) => {
        setMutationError(err instanceof Error ? err.message : 'Sleep failed');
      }),
    );
    void Promise.all(promises).then(() => {
      setBulkSleepOpen(false);
      setSelectedModelNames(new Set());
    });
  };

  // Bulk delete: delete all selected models
  const handleBulkDelete = () => {
    const selectedList = [...selectedModelNames];
    setMutationError(null);
    const promises = selectedList.map((name) =>
      deleteModel.mutateAsync(name).catch((err: unknown) => {
        setMutationError(err instanceof Error ? err.message : 'Delete failed');
      }),
    );
    void Promise.all(promises).then(() => {
      setBulkDeleteOpen(false);
      setSelectedModelNames(new Set());
    });
  };

  if (isLoading) {
    return (
      <PageSection>
        <Spinner aria-label={t('list.heading')} />
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant={AlertVariant.danger} title={t('list.errors.failedToLoad')} isInline>
          {error instanceof Error ? error.message : 'Unknown error'}
        </Alert>
      </PageSection>
    );
  }

  const isEmpty =
    filteredAndSorted.length === 0 &&
    selectedStates.length === 0 &&
    selectedRunners.length === 0 &&
    (models ?? []).length === 0;

  const isFiltered = selectedStates.length > 0 || selectedRunners.length > 0;
  const hasNoResults = filteredAndSorted.length === 0 && isFiltered;

  const paginationComponent = (variant: 'top' | 'bottom') => (
    <Pagination
      itemCount={totalItems}
      perPage={pageSize}
      page={currentPage}
      onSetPage={(_ev, page) => setCurrentPage(page)}
      onPerPageSelect={(_ev, perPage) => {
        setPageSize(perPage);
        setCurrentPage(1);
      }}
      perPageOptions={[
        { title: '10', value: 10 },
        { title: '20', value: 20 },
        { title: '50', value: 50 },
      ]}
      variant={variant}
      isCompact={variant === 'top'}
      aria-label={t('list.pagination.ariaLabel')}
    />
  );

  return (
    <PageSection>
      <Content>
        <h1>{t('list.heading')}</h1>
      </Content>

      {mutationError && (
        <Alert
          variant={AlertVariant.danger}
          title={t('list.errors.actionFailed')}
          isInline
          actionClose={
            <Button
              variant="plain"
              onClick={() => setMutationError(null)}
              aria-label={t('list.errors.actionFailed')}
            />
          }
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {mutationError}
        </Alert>
      )}

      <Toolbar>
        <ToolbarContent>
          {/* Bulk select checkbox — only shown to admins */}
          {isAdmin && (
            <ToolbarGroup variant="action-group-plain">
              <ToolbarItem>
                <Checkbox
                  id="select-all-models"
                  aria-label={tCommon('actions.selectAll')}
                  isChecked={allPageSelected ? true : somePageSelected ? null : false}
                  onChange={toggleSelectAll}
                  isDisabled={paginatedModels.length === 0}
                />
              </ToolbarItem>
              {selectedCount > 0 && (
                <>
                  <ToolbarItem>
                    <span style={{ fontSize: 'var(--pf-t--global--font--size--sm)' }}>
                      {t('list.bulkActions.selected', { count: selectedCount })}
                    </span>
                  </ToolbarItem>
                  <ToolbarItem>
                    <Button
                      variant="secondary"
                      onClick={() => setBulkSleepOpen(true)}
                      isDisabled={sleepModel.isPending || deleteModel.isPending}
                    >
                      {t('list.bulkActions.sleep')}
                    </Button>
                  </ToolbarItem>
                  <ToolbarItem>
                    <Button
                      variant="danger"
                      onClick={() => setBulkDeleteOpen(true)}
                      isDisabled={sleepModel.isPending || deleteModel.isPending}
                    >
                      {t('list.bulkActions.delete')}
                    </Button>
                  </ToolbarItem>
                </>
              )}
            </ToolbarGroup>
          )}

          {/* State filter */}
          <ToolbarItem>
            <ToolbarFilter
              labels={selectedStates.map((s) =>
                tCommon(STATE_LOCALE_KEYS[s as ModelLifecycleState]),
              )}
              deleteLabel={(_category, label) => {
                const val = ALL_STATES.find((s) => tCommon(STATE_LOCALE_KEYS[s]) === label);
                if (val) onStateFilterSelect(val);
              }}
              deleteLabelGroup={() => {
                setSelectedStates([]);
                setCurrentPage(1);
              }}
              categoryName={t('list.filterByState')}
            >
              <Select
                aria-label={t('list.filterByState')}
                isOpen={stateFilterOpen}
                onOpenChange={(open) => setStateFilterOpen(open)}
                selected={selectedStates}
                onSelect={(_ev, value) => onStateFilterSelect(value as string)}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    onClick={() => setStateFilterOpen(!stateFilterOpen)}
                    isExpanded={stateFilterOpen}
                    style={{ minWidth: '160px' }}
                  >
                    {selectedStates.length > 0
                      ? t('list.filterStateCount', { count: selectedStates.length })
                      : t('list.filterByState')}
                  </MenuToggle>
                )}
              >
                {ALL_STATES.map((s) => (
                  <SelectOption
                    key={s}
                    value={s}
                    hasCheckbox
                    isSelected={selectedStates.includes(s)}
                  >
                    {tCommon(STATE_LOCALE_KEYS[s])}
                  </SelectOption>
                ))}
              </Select>
            </ToolbarFilter>
          </ToolbarItem>

          {/* Runner-type filter */}
          {allRunnerTypes.length > 0 && (
            <ToolbarItem>
              <ToolbarFilter
                labels={selectedRunners}
                deleteLabel={(_category, label) => onRunnerFilterSelect(label as string)}
                deleteLabelGroup={() => {
                  setSelectedRunners([]);
                  setCurrentPage(1);
                }}
                categoryName={t('list.filterByRunner')}
              >
                <Select
                  aria-label={t('list.filterByRunner')}
                  isOpen={runnerFilterOpen}
                  onOpenChange={(open) => setRunnerFilterOpen(open)}
                  selected={selectedRunners}
                  onSelect={(_ev, value) => onRunnerFilterSelect(value as string)}
                  toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                    <MenuToggle
                      ref={toggleRef}
                      onClick={() => setRunnerFilterOpen(!runnerFilterOpen)}
                      isExpanded={runnerFilterOpen}
                      style={{ minWidth: '160px' }}
                    >
                      {selectedRunners.length > 0
                        ? t('list.filterRunnerCount', { count: selectedRunners.length })
                        : t('list.filterByRunner')}
                    </MenuToggle>
                  )}
                >
                  {allRunnerTypes.map((rt) => (
                    <SelectOption
                      key={rt}
                      value={rt}
                      hasCheckbox
                      isSelected={selectedRunners.includes(rt)}
                    >
                      {rt}
                    </SelectOption>
                  ))}
                </Select>
              </ToolbarFilter>
            </ToolbarItem>
          )}

          {isAdmin && (
            <ToolbarItem align={{ default: 'alignEnd' }}>
              <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
                {t('deploy.title')}
              </Button>
            </ToolbarItem>
          )}

          {/* Pagination top */}
          {!isEmpty && !hasNoResults && (
            <ToolbarItem align={{ default: 'alignEnd' }}>{paginationComponent('top')}</ToolbarItem>
          )}
        </ToolbarContent>
      </Toolbar>

      {isEmpty ? (
        <EmptyState headingLevel="h2" icon={CubesIcon} titleText={t('list.empty.title')}>
          <EmptyStateBody>{t('list.empty.body')}</EmptyStateBody>
          {isAdmin && (
            <EmptyStateFooter>
              <EmptyStateActions>
                <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
                  {t('deploy.title')}
                </Button>
              </EmptyStateActions>
            </EmptyStateFooter>
          )}
        </EmptyState>
      ) : hasNoResults ? (
        <EmptyState headingLevel="h2" titleText={t('list.emptyFiltered.title')}>
          <EmptyStateBody>{t('list.emptyFiltered.body')}</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button
                variant="link"
                onClick={() => {
                  setSelectedStates([]);
                  setSelectedRunners([]);
                }}
              >
                {tCommon('actions.clearFilters')}
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : (
        <>
          <Table aria-label={t('list.heading')} variant="compact">
            <Thead>
              <Tr>
                {isAdmin && (
                  <Th
                    select={{
                      onSelect: toggleSelectAll,
                      isSelected: allPageSelected,
                      isHeaderSelectDisabled: paginatedModels.length === 0,
                    }}
                    aria-label={tCommon('actions.selectAll')}
                  />
                )}
                <Th sort={getSortParams('modelName')}>{t('list.table.modelName')}</Th>
                <Th sort={getSortParams('state')}>{t('list.table.state')}</Th>
                <Th>{t('list.table.runnerType')}</Th>
                <Th>{t('list.table.worker')}</Th>
                <Th>{t('list.instances.columnHeader')}</Th>
                <Th sort={getSortParams('currentMemory')}>{t('list.table.memory')}</Th>
                <Th sort={getSortParams('lastInferenceAt')}>{t('list.table.lastInference')}</Th>
                <Th>{t('list.table.pinned')}</Th>
                {isAdmin && <Th aria-label={t('list.table.actions')} />}
              </Tr>
            </Thead>
            <Tbody>
              {paginatedModels.map((model) => {
                const required = model.requiredMemory ?? 0;
                const current = model.currentMemory;
                const hasCurrent = current != null;
                const ratio = required > 0 && hasCurrent ? current / required : 0;
                const memVariant = getMemoryVariant(ratio);

                return (
                  <Tr key={model.modelName}>
                    {isAdmin && (
                      <Td
                        select={{
                          rowIndex: paginatedModels.indexOf(model),
                          onSelect: () => toggleSelectModel(model.modelName),
                          isSelected: selectedModelNames.has(model.modelName),
                        }}
                      />
                    )}
                    <Td dataLabel={t('list.table.modelName')}>
                      <Link to={`/models/${encodeURIComponent(model.modelName)}`}>
                        {model.displayName ?? model.modelName}
                      </Link>
                      {model.displayName && (
                        <div
                          style={{
                            fontSize: 'var(--pf-t--global--font--size--xs)',
                            color: 'var(--pf-t--global--text--color--subtle)',
                          }}
                        >
                          {model.modelName}
                        </div>
                      )}
                    </Td>
                    <Td dataLabel={t('list.table.state')}>
                      <StateLabel state={model.state} />
                    </Td>
                    <Td dataLabel={t('list.table.runnerType')}>{model.runnerType}</Td>
                    <Td dataLabel={t('list.table.worker')}>
                      {model.workerId ? (
                        <Link to={`/workers/${encodeURIComponent(model.workerId)}`}>
                          {model.workerId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td dataLabel={t('list.instances.columnHeader')}>
                      <Link to={`/models/${encodeURIComponent(model.modelName)}`}>
                        {t('list.instances.count', { count: model.instanceCount })}
                      </Link>
                    </Td>
                    <Td dataLabel={t('list.table.memory')} style={{ minWidth: '160px' }}>
                      {required > 0 ? (
                        <div>
                          {hasCurrent && (
                            <Progress
                              value={Math.min(100, ratio * 100)}
                              size={ProgressSize.sm}
                              variant={memVariant}
                              aria-label={t('list.table.memory')}
                            />
                          )}
                          <div
                            style={{
                              fontSize: 'var(--pf-t--global--font--size--xs)',
                              color: 'var(--pf-t--global--text--color--subtle)',
                              marginTop: 'var(--pf-t--global--spacer--xs)',
                            }}
                          >
                            {hasCurrent ? formatBytes(current) : '—'} / {formatBytes(required)}
                          </div>
                        </div>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td dataLabel={t('list.table.lastInference')}>
                      {formatRelativeTime(model.lastInferenceAt)}
                    </Td>
                    <Td dataLabel={t('list.table.pinned')}>
                      {model.pinned ? <LockIcon aria-label={t('list.table.pinned')} /> : null}
                    </Td>
                    {isAdmin && (
                      <Td dataLabel={t('list.table.actions')} isActionCell>
                        <Dropdown
                          isOpen={openMenuId === model.modelName}
                          onSelect={() => setOpenMenuId(null)}
                          onOpenChange={(isOpen) => {
                            if (!isOpen) setOpenMenuId(null);
                          }}
                          toggle={(toggleRef) => (
                            <MenuToggle
                              ref={toggleRef}
                              variant="plain"
                              onClick={() =>
                                setOpenMenuId(
                                  openMenuId === model.modelName ? null : model.modelName,
                                )
                              }
                              isExpanded={openMenuId === model.modelName}
                              aria-label={`Actions for ${model.modelName}`}
                            >
                              <EllipsisVIcon />
                            </MenuToggle>
                          )}
                          popperProps={{ position: 'right' }}
                        >
                          <DropdownList>
                            {model.state !== ModelLifecycleState.STOPPED && (
                              <DropdownItem
                                key="add-instance"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  handleAddInstance(model);
                                }}
                              >
                                {t('list.addInstance.menuItem')}
                              </DropdownItem>
                            )}
                            {model.state === ModelLifecycleState.ACTIVE && (
                              <DropdownItem
                                key="sleep"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setSleepConfirmModel(model);
                                }}
                              >
                                {t('list.sleep.menuItem')}
                              </DropdownItem>
                            )}
                            {model.state === ModelLifecycleState.SLEEPING && (
                              <DropdownItem
                                key="wake"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  handleWake(model);
                                }}
                              >
                                {t('list.wake.menuItem')}
                              </DropdownItem>
                            )}
                            {model.state === ModelLifecycleState.STOPPED && (
                              <DropdownItem
                                key="start"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  handleStart(model);
                                }}
                              >
                                {t('list.start.menuItem')}
                              </DropdownItem>
                            )}
                            {(model.state === ModelLifecycleState.ACTIVE ||
                              model.state === ModelLifecycleState.SLEEPING ||
                              model.state === ModelLifecycleState.ERROR) && (
                              <DropdownItem
                                key="stop"
                                onClick={() => {
                                  setOpenMenuId(null);
                                  setStopConfirmModel(model);
                                }}
                              >
                                {t('list.stop.menuItem')}
                              </DropdownItem>
                            )}
                            <DropdownItem
                              key="delete"
                              isDanger
                              onClick={() => {
                                setOpenMenuId(null);
                                setDeleteConfirmModel(model);
                              }}
                            >
                              {t('list.delete.menuItem')}
                            </DropdownItem>
                          </DropdownList>
                        </Dropdown>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </Tbody>
          </Table>

          {/* Pagination bottom */}
          {paginationComponent('bottom')}
        </>
      )}

      {/* Sleep confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={sleepConfirmModel !== null}
        onClose={() => setSleepConfirmModel(null)}
        aria-label={t('list.sleep.confirmTitle')}
      >
        <ModalHeader title={t('list.sleep.confirmTitle')} />
        <ModalBody>
          {t('list.sleep.confirmBody', { modelName: sleepConfirmModel?.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleSleepConfirm} isLoading={sleepModel.isPending}>
            {t('list.sleep.menuItem')}
          </Button>
          <Button variant="link" onClick={() => setSleepConfirmModel(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Stop confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={stopConfirmModel !== null}
        onClose={() => setStopConfirmModel(null)}
        aria-label={t('list.stop.confirmTitle')}
      >
        <ModalHeader title={t('list.stop.confirmTitle')} titleIconVariant="warning" />
        <ModalBody>
          {t('list.stop.confirmBody', { modelName: stopConfirmModel?.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleStopConfirm} isLoading={stopModel.isPending}>
            {t('list.stop.menuItem')}
          </Button>
          <Button variant="link" onClick={() => setStopConfirmModel(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={deleteConfirmModel !== null}
        onClose={() => setDeleteConfirmModel(null)}
        aria-label={t('list.delete.confirmTitle')}
      >
        <ModalHeader title={t('list.delete.confirmTitle')} titleIconVariant="danger" />
        <ModalBody>
          {t('list.delete.confirmBody', { modelName: deleteConfirmModel?.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleDeleteConfirm} isLoading={deleteModel.isPending}>
            {t('list.delete.menuItem')}
          </Button>
          <Button variant="link" onClick={() => setDeleteConfirmModel(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Bulk sleep confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={bulkSleepOpen}
        onClose={() => setBulkSleepOpen(false)}
        aria-label={t('list.bulkActions.sleep')}
      >
        <ModalHeader title={t('list.bulkActions.sleepConfirmTitle')} />
        <ModalBody>{t('list.bulkActions.sleepConfirmBody', { count: selectedCount })}</ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleBulkSleep} isLoading={sleepModel.isPending}>
            {t('list.bulkActions.sleep')}
          </Button>
          <Button variant="link" onClick={() => setBulkSleepOpen(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Bulk delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={bulkDeleteOpen}
        onClose={() => setBulkDeleteOpen(false)}
        aria-label={t('list.bulkActions.delete')}
      >
        <ModalHeader title={t('list.bulkActions.deleteConfirmTitle')} titleIconVariant="danger" />
        <ModalBody>{t('list.bulkActions.deleteConfirmBody', { count: selectedCount })}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleBulkDelete} isLoading={deleteModel.isPending}>
            {t('list.bulkActions.delete')}
          </Button>
          <Button variant="link" onClick={() => setBulkDeleteOpen(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
