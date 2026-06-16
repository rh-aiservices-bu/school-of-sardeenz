import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td, type ThProps } from '@patternfly/react-table';
import { EllipsisVIcon, LockIcon, CubesIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import { useModels, useSleepModel, useWakeModel, useDeleteModel } from '../../hooks/useModels';
import type { ModelInfo } from '../../api/client';
import { StateLabel } from '../../components/StateLabel';
import { formatBytes, formatRelativeTime } from '../../utils/format';

type SortField = 'modelName' | 'lastInferenceAt';
type SortDirection = 'asc' | 'desc';

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

export function ModelList() {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const navigate = useNavigate();
  const { data: models, isLoading, error } = useModels();
  const sleepModel = useSleepModel();
  const wakeModel = useWakeModel();
  const deleteModel = useDeleteModel();

  // Sorting
  const [sortField, setSortField] = useState<SortField>('modelName');
  const [sortDir, setSortDir] = useState<SortDirection>('asc');

  // Filtering
  const [filterOpen, setFilterOpen] = useState(false);
  const [selectedStates, setSelectedStates] = useState<string[]>([]);

  // Kebab menu
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // Modals
  const [sleepConfirmModel, setSleepConfirmModel] = useState<ModelInfo | null>(null);
  const [deleteConfirmModel, setDeleteConfirmModel] = useState<ModelInfo | null>(null);

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
    const columnIndex = field === 'modelName' ? 0 : 5;
    return {
      sortBy: {
        index: sortField === 'modelName' ? 0 : 5,
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
  };

  const filteredAndSorted = (models ?? [])
    .filter((m) => selectedStates.length === 0 || selectedStates.includes(m.state))
    .sort((a, b) => {
      let cmp = 0;
      if (sortField === 'modelName') {
        cmp = a.modelName.localeCompare(b.modelName);
      } else {
        const aTime = a.lastInferenceAt ? new Date(a.lastInferenceAt).getTime() : 0;
        const bTime = b.lastInferenceAt ? new Date(b.lastInferenceAt).getTime() : 0;
        cmp = aTime - bTime;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

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
        <Alert
          variant={AlertVariant.danger}
          title={t('list.errors.failedToLoad')}
          isInline
        >
          {error instanceof Error ? error.message : 'Unknown error'}
        </Alert>
      </PageSection>
    );
  }

  const isEmpty = filteredAndSorted.length === 0 && selectedStates.length === 0 && (models ?? []).length === 0;

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
          actionClose={<Button variant="plain" onClick={() => setMutationError(null)} aria-label={t('list.errors.actionFailed')} />}
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {mutationError}
        </Alert>
      )}

      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <ToolbarFilter
              labels={selectedStates.map((s) => tCommon(STATE_LOCALE_KEYS[s as ModelLifecycleState]))}
              deleteLabel={(_category, label) => {
                const val = ALL_STATES.find((s) => tCommon(STATE_LOCALE_KEYS[s]) === label);
                if (val) onStateFilterSelect(val);
              }}
              deleteLabelGroup={() => setSelectedStates([])}
              categoryName="State"
            >
              <Select
                aria-label={t('list.filterByState')}
                isOpen={filterOpen}
                onOpenChange={(open) => setFilterOpen(open)}
                selected={selectedStates}
                onSelect={(_ev, value) => onStateFilterSelect(value as string)}
                toggle={(toggleRef: React.Ref<MenuToggleElement>) => (
                  <MenuToggle
                    ref={toggleRef}
                    onClick={() => setFilterOpen(!filterOpen)}
                    isExpanded={filterOpen}
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
          <ToolbarItem align={{ default: 'alignEnd' }}>
            <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
              {t('deploy.title')}
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {isEmpty ? (
        <EmptyState
          headingLevel="h2"
          icon={CubesIcon}
          titleText={t('list.empty.title')}
        >
          <EmptyStateBody>
            {t('list.empty.body')}
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
                {t('deploy.title')}
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState headingLevel="h2" titleText={t('list.emptyFiltered.title')}>
          <EmptyStateBody>{t('list.emptyFiltered.body')}</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="link" onClick={() => setSelectedStates([])}>
                {tCommon('actions.clearFilters')}
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : (
        <Table aria-label={t('list.heading')} variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams('modelName')}>{t('list.table.modelName')}</Th>
              <Th>{t('list.table.state')}</Th>
              <Th>{t('list.table.runnerType')}</Th>
              <Th>{t('list.table.worker')}</Th>
              <Th>{t('list.table.memory')}</Th>
              <Th sort={getSortParams('lastInferenceAt')}>{t('list.table.lastInference')}</Th>
              <Th>{t('list.table.pinned')}</Th>
              <Th aria-label={t('list.table.actions')} />
            </Tr>
          </Thead>
          <Tbody>
            {filteredAndSorted.map((model) => (
              <Tr key={model.modelName}>
                <Td dataLabel={t('list.table.modelName')}>
                  <Link to={`/models/${encodeURIComponent(model.modelName)}`}>
                    {model.modelName}
                  </Link>
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
                <Td dataLabel={t('list.table.memory')}>
                  {formatBytes(model.currentMemory)} / {formatBytes(model.requiredMemory)}
                </Td>
                <Td dataLabel={t('list.table.lastInference')}>
                  {formatRelativeTime(model.lastInferenceAt)}
                </Td>
                <Td dataLabel={t('list.table.pinned')}>
                  {model.pinned ? (
                    <LockIcon aria-label={t('list.table.pinned')} />
                  ) : null}
                </Td>
                <Td dataLabel={t('list.table.actions')} isActionCell>
                  <Dropdown
                    isOpen={openMenuId === model.modelName}
                    onSelect={() => setOpenMenuId(null)}
                    onOpenChange={(isOpen) => { if (!isOpen) setOpenMenuId(null); }}
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
              </Tr>
            ))}
          </Tbody>
        </Table>
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

      {/* Delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={deleteConfirmModel !== null}
        onClose={() => setDeleteConfirmModel(null)}
        aria-label={t('list.delete.confirmTitle')}
      >
        <ModalHeader
          title={t('list.delete.confirmTitle')}
          titleIconVariant="danger"
        />
        <ModalBody>
          {t('list.delete.confirmBody', { modelName: deleteConfirmModel?.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={handleDeleteConfirm}
            isLoading={deleteModel.isPending}
          >
            {t('list.delete.menuItem')}
          </Button>
          <Button variant="link" onClick={() => setDeleteConfirmModel(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
