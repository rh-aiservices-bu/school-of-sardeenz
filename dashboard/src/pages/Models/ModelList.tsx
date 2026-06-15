import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
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

function stateLabel(state: ModelLifecycleState): string {
  return state.charAt(0) + state.slice(1).toLowerCase();
}

export function ModelList() {
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
        <Spinner aria-label="Loading models" />
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert
          variant={AlertVariant.danger}
          title="Failed to load models"
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
        <h1>Models</h1>
      </Content>

      {mutationError && (
        <Alert
          variant={AlertVariant.danger}
          title="Action failed"
          isInline
          actionClose={<Button variant="plain" onClick={() => setMutationError(null)} aria-label="Close alert" />}
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {mutationError}
        </Alert>
      )}

      <Toolbar>
        <ToolbarContent>
          <ToolbarItem>
            <ToolbarFilter
              labels={selectedStates.map((s) => stateLabel(s as ModelLifecycleState))}
              deleteLabel={(_category, label) => {
                const val = ALL_STATES.find((s) => stateLabel(s) === label);
                if (val) onStateFilterSelect(val);
              }}
              deleteLabelGroup={() => setSelectedStates([])}
              categoryName="State"
            >
              <Select
                aria-label="Filter by state"
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
                      ? `State (${selectedStates.length})`
                      : 'Filter by state'}
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
                    {stateLabel(s)}
                  </SelectOption>
                ))}
              </Select>
            </ToolbarFilter>
          </ToolbarItem>
          <ToolbarItem align={{ default: 'alignEnd' }}>
            <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
              Deploy Model
            </Button>
          </ToolbarItem>
        </ToolbarContent>
      </Toolbar>

      {isEmpty ? (
        <EmptyState
          headingLevel="h2"
          icon={CubesIcon}
          titleText="No models deployed"
        >
          <EmptyStateBody>
            Deploy a model to get started with inference.
          </EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="primary" onClick={() => void navigate('/models/deploy')}>
                Deploy Model
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : filteredAndSorted.length === 0 ? (
        <EmptyState headingLevel="h2" titleText="No models match the filter">
          <EmptyStateBody>Try adjusting or clearing the state filter.</EmptyStateBody>
          <EmptyStateFooter>
            <EmptyStateActions>
              <Button variant="link" onClick={() => setSelectedStates([])}>
                Clear filters
              </Button>
            </EmptyStateActions>
          </EmptyStateFooter>
        </EmptyState>
      ) : (
        <Table aria-label="Model list" variant="compact">
          <Thead>
            <Tr>
              <Th sort={getSortParams('modelName')}>Model Name</Th>
              <Th>State</Th>
              <Th>Runner Type</Th>
              <Th>Worker</Th>
              <Th>Memory</Th>
              <Th sort={getSortParams('lastInferenceAt')}>Last Inference</Th>
              <Th>Pinned</Th>
              <Th aria-label="Actions" />
            </Tr>
          </Thead>
          <Tbody>
            {filteredAndSorted.map((model) => (
              <Tr key={model.modelName}>
                <Td dataLabel="Model Name">
                  <Link to={`/models/${encodeURIComponent(model.modelName)}`}>
                    {model.modelName}
                  </Link>
                </Td>
                <Td dataLabel="State">
                  <StateLabel state={model.state} />
                </Td>
                <Td dataLabel="Runner Type">{model.runnerType}</Td>
                <Td dataLabel="Worker">
                  {model.workerId ? (
                    <Link to={`/workers/${encodeURIComponent(model.workerId)}`}>
                      {model.workerId}
                    </Link>
                  ) : (
                    '—'
                  )}
                </Td>
                <Td dataLabel="Memory">
                  {formatBytes(model.currentMemory)} / {formatBytes(model.requiredMemory)}
                </Td>
                <Td dataLabel="Last Inference">
                  {formatRelativeTime(model.lastInferenceAt)}
                </Td>
                <Td dataLabel="Pinned">
                  {model.pinned ? (
                    <LockIcon aria-label="Pinned" />
                  ) : null}
                </Td>
                <Td dataLabel="Actions" isActionCell>
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
                          Sleep
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
                          Wake
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
                        Delete
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
        aria-label="Confirm sleep"
      >
        <ModalHeader title="Put model to sleep?" />
        <ModalBody>
          This will put <strong>{sleepConfirmModel?.modelName}</strong> to sleep, freeing its device
          memory. It can be woken back up on demand.
        </ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleSleepConfirm} isLoading={sleepModel.isPending}>
            Sleep
          </Button>
          <Button variant="link" onClick={() => setSleepConfirmModel(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={deleteConfirmModel !== null}
        onClose={() => setDeleteConfirmModel(null)}
        aria-label="Confirm delete"
      >
        <ModalHeader
          title="Delete model?"
          titleIconVariant="danger"
        />
        <ModalBody>
          This will permanently delete <strong>{deleteConfirmModel?.modelName}</strong> and remove it
          from the cluster. This action cannot be undone.
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={handleDeleteConfirm}
            isLoading={deleteModel.isPending}
          >
            Delete
          </Button>
          <Button variant="link" onClick={() => setDeleteConfirmModel(null)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
