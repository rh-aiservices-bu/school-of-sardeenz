import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  PageSection,
  Content,
  Breadcrumb,
  BreadcrumbItem,
  Button,
  DescriptionList,
  DescriptionListGroup,
  DescriptionListTerm,
  DescriptionListDescription,
  Alert,
  AlertVariant,
  Progress,
  ExpandableSection,
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Spinner,
  Flex,
  FlexItem,
  CodeBlock,
  CodeBlockCode,
  Title,
} from '@patternfly/react-core';
import { Table, Thead, Tbody, Tr, Th, Td } from '@patternfly/react-table';
import { LockIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import {
  useModel,
  useSleepModel,
  useWakeModel,
  useDeleteModel,
  useStopModel,
  useStartModel,
  useAddInstance,
  useDeleteInstance,
  useSleepInstance,
  useWakeInstance,
} from '../../hooks/useModels';
import { ApiError } from '../../api/client';
import { StateLabel } from '../../components/StateLabel';
import { DeployLogsModal } from '../../components/DeployLogsModal';
import { formatBytes, formatRelativeTime, formatDateTime } from '../../utils/format';
import { useAuth } from '../../contexts/AuthContext';

export function ModelDetail() {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const { modelName } = useParams<{ modelName: string }>();
  const navigate = useNavigate();
  const { isAdmin } = useAuth();

  const { data: model, isLoading, error } = useModel(modelName ?? '');
  const sleepModel = useSleepModel();
  const wakeModel = useWakeModel();
  const deleteModel = useDeleteModel();
  const stopModel = useStopModel();
  const startModel = useStartModel();
  const addInstance = useAddInstance();
  const deleteInstance = useDeleteInstance();
  const sleepInstance = useSleepInstance();
  const wakeInstance = useWakeInstance();

  const [showSleepModal, setShowSleepModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [showStopModal, setShowStopModal] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [engineConfigExpanded, setEngineConfigExpanded] = useState(false);
  const [showLogsModal, setShowLogsModal] = useState(false);
  const [deleteInstanceId, setDeleteInstanceId] = useState<string | null>(null);

  const handleSleepConfirm = () => {
    if (!modelName) return;
    setMutationError(null);
    sleepModel.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Sleep failed'),
      onSettled: () => setShowSleepModal(false),
    });
  };

  const handleWake = () => {
    if (!modelName) return;
    setMutationError(null);
    wakeModel.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Wake failed'),
    });
  };

  const handleDeleteConfirm = () => {
    if (!modelName) return;
    setMutationError(null);
    deleteModel.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Delete failed'),
      onSuccess: () => void navigate('/models'),
      onSettled: () => setShowDeleteModal(false),
    });
  };

  const handleStart = () => {
    if (!modelName) return;
    setMutationError(null);
    startModel.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Start failed'),
    });
  };

  const handleStopConfirm = () => {
    if (!modelName) return;
    setMutationError(null);
    stopModel.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Stop failed'),
      onSettled: () => setShowStopModal(false),
    });
  };

  const handleAddInstance = () => {
    if (!modelName) return;
    setMutationError(null);
    addInstance.mutate(modelName, {
      onError: (err) => setMutationError(err instanceof Error ? err.message : 'Add instance failed'),
    });
  };

  const handleSleepInstance = (instanceId: string) => {
    if (!modelName) return;
    setMutationError(null);
    sleepInstance.mutate(
      { modelName, instanceId },
      {
        onError: (err) =>
          setMutationError(err instanceof Error ? err.message : 'Sleep instance failed'),
      },
    );
  };

  const handleWakeInstance = (instanceId: string) => {
    if (!modelName) return;
    setMutationError(null);
    wakeInstance.mutate(
      { modelName, instanceId },
      {
        onError: (err) =>
          setMutationError(err instanceof Error ? err.message : 'Wake instance failed'),
      },
    );
  };

  const handleDeleteInstanceConfirm = () => {
    if (!modelName || !deleteInstanceId) return;
    setMutationError(null);
    deleteInstance.mutate(
      { modelName, instanceId: deleteInstanceId },
      {
        onError: (err) =>
          setMutationError(err instanceof Error ? err.message : 'Delete instance failed'),
        onSettled: () => setDeleteInstanceId(null),
      },
    );
  };

  // Loading state
  if (isLoading) {
    return (
      <PageSection>
        <Spinner aria-label={t('detail.fields.state')} />
      </PageSection>
    );
  }

  // 404 state
  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageSection>
        <Alert variant={AlertVariant.warning} title={t('detail.errors.notFound')} isInline>
          {t('detail.errors.notFoundBody', { modelName })}{' '}
          <Link to="/models">{t('detail.errors.backToModels')}</Link>
        </Alert>
      </PageSection>
    );
  }

  // Generic error state
  if (error || !model) {
    return (
      <PageSection>
        <Alert variant={AlertVariant.danger} title={t('detail.errors.failedToLoad')} isInline>
          {error instanceof Error ? error.message : 'Unknown error'}
        </Alert>
      </PageSection>
    );
  }

  const isActive = model.state === ModelLifecycleState.ACTIVE;
  const isSleeping = model.state === ModelLifecycleState.SLEEPING;
  const isError = model.state === ModelLifecycleState.ERROR;
  const isStarting = model.state === ModelLifecycleState.STARTING;
  const isStopped = model.state === ModelLifecycleState.STOPPED;

  // Placement/runtime fields (worker, endpoint, memory, progress, per-instance error) live on
  // each instance now (#120) — the model-level `state` above is the aggregate across them.
  const instances = model.instances ?? [];
  const errorInstance = instances.find((i) => i.state === ModelLifecycleState.ERROR);
  const startingInstance = instances.find((i) => i.state === ModelLifecycleState.STARTING);

  const engineConfigJson = model.engineConfig ? JSON.stringify(model.engineConfig, null, 2) : null;

  return (
    <PageSection>
      {/* Breadcrumb */}
      <Breadcrumb style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
        <BreadcrumbItem>
          <Link to="/">{t('detail.breadcrumb.cluster')}</Link>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <Link to="/models">{t('detail.breadcrumb.models')}</Link>
        </BreadcrumbItem>
        <BreadcrumbItem isActive>{model.modelName}</BreadcrumbItem>
      </Breadcrumb>

      {/* Header */}
      <Flex
        alignItems={{ default: 'alignItemsCenter' }}
        style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        gap={{ default: 'gapMd' }}
      >
        <FlexItem>
          <Title headingLevel="h1">{model.modelName}</Title>
        </FlexItem>
        <FlexItem>
          <StateLabel state={model.state} />
        </FlexItem>
        {(isStarting || isActive || isError) && (
          <FlexItem align={{ default: !isAdmin ? 'alignRight' : undefined }}>
            <Button variant="secondary" onClick={() => setShowLogsModal(true)}>
              {t('detail.viewLogs.button')}
            </Button>
          </FlexItem>
        )}
        {isAdmin && (
          <FlexItem align={{ default: 'alignRight' }}>
            <Flex gap={{ default: 'gapSm' }}>
              {!isStopped && (
                <FlexItem>
                  <Button
                    variant="secondary"
                    onClick={handleAddInstance}
                    isLoading={addInstance.isPending}
                  >
                    {t('detail.addInstance.button')}
                  </Button>
                </FlexItem>
              )}
              {isActive && (
                <FlexItem>
                  <Button variant="secondary" onClick={() => setShowSleepModal(true)}>
                    {t('detail.sleep.button')}
                  </Button>
                </FlexItem>
              )}
              {(isSleeping || isError) && (
                <FlexItem>
                  <Button variant="primary" onClick={handleWake} isLoading={wakeModel.isPending}>
                    {t('detail.wake.button')}
                  </Button>
                </FlexItem>
              )}
              {isStopped && (
                <FlexItem>
                  <Button variant="primary" onClick={handleStart} isLoading={startModel.isPending}>
                    {t('detail.start.button')}
                  </Button>
                </FlexItem>
              )}
              {(isActive || isSleeping || isError) && (
                <FlexItem>
                  <Button variant="secondary" onClick={() => setShowStopModal(true)}>
                    {t('detail.stop.button')}
                  </Button>
                </FlexItem>
              )}
              <FlexItem>
                <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                  {t('detail.delete.button')}
                </Button>
              </FlexItem>
            </Flex>
          </FlexItem>
        )}
      </Flex>

      {/* Mutation error */}
      {mutationError && (
        <Alert
          variant={AlertVariant.danger}
          title={t('detail.errors.actionFailed')}
          isInline
          actionClose={
            <Button
              variant="plain"
              onClick={() => setMutationError(null)}
              aria-label={t('detail.errors.actionFailed')}
            />
          }
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {mutationError}
        </Alert>
      )}

      {/* ERROR alert */}
      {isError && errorInstance?.errorMessage && (
        <Alert
          variant={AlertVariant.danger}
          title={t('detail.errors.modelError')}
          isInline
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          actionLinks={
            isAdmin ? (
              <Flex gap={{ default: 'gapSm' }}>
                <FlexItem>
                  <Button variant="secondary" onClick={handleWake} isLoading={wakeModel.isPending}>
                    {t('detail.wake.button')}
                  </Button>
                </FlexItem>
                <FlexItem>
                  <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                    {t('detail.delete.button')}
                  </Button>
                </FlexItem>
              </Flex>
            ) : undefined
          }
        >
          {errorInstance.errorMessage}
        </Alert>
      )}

      {/* STARTING progress (the starting instance's — with replicas, other instances may already
          be ACTIVE and serving) */}
      {isStarting && startingInstance?.progress && (
        <div style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
          <Progress
            aria-label={t('detail.fields.state')}
            value={startingInstance.progress.percentComplete ?? 0}
            title={
              startingInstance.progress.phase
                ? `${t('detail.progress.phasePrefix')}${startingInstance.progress.phase}`
                : tCommon('loading')
            }
          />
          {startingInstance.progress.message && (
            <Content
              component="small"
              style={{
                display: 'block',
                marginTop: 'var(--pf-t--global--spacer--sm)',
                color: 'var(--pf-t--global--color--nonstatus--gray--default)',
              }}
            >
              {startingInstance.progress.message}
              {startingInstance.progress.estimatedRemainingSeconds != null &&
                t('detail.progress.remainingSeconds', {
                  seconds: startingInstance.progress.estimatedRemainingSeconds,
                })}
            </Content>
          )}
        </div>
      )}

      {/* Detail section */}
      <DescriptionList
        isHorizontal
        horizontalTermWidthModifier={{ default: '20ch' }}
        style={{ marginBottom: 'var(--pf-t--global--spacer--lg)' }}
      >
        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.state')}</DescriptionListTerm>
          <DescriptionListDescription>
            <StateLabel state={model.state} />
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.runnerType')}</DescriptionListTerm>
          <DescriptionListDescription>{model.runnerType}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.modelPath')}</DescriptionListTerm>
          <DescriptionListDescription>
            <code style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}>
              {model.modelPath}
            </code>
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.requiredMemory')}</DescriptionListTerm>
          <DescriptionListDescription>
            {formatBytes(model.requiredMemory)}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.deviceType')}</DescriptionListTerm>
          <DescriptionListDescription>{model.deviceType ?? '—'}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.tensorParallel')}</DescriptionListTerm>
          <DescriptionListDescription>
            {model.tensorParallel != null ? model.tensorParallel : '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.runtimeModule')}</DescriptionListTerm>
          <DescriptionListDescription>{model.runtimeModule ?? '—'}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.pinned')}</DescriptionListTerm>
          <DescriptionListDescription>
            {model.pinned ? (
              <Flex gap={{ default: 'gapXs' }} alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem>
                  <LockIcon aria-hidden />
                </FlexItem>
                <FlexItem>{t('detail.pinned.yes')}</FlexItem>
              </Flex>
            ) : (
              t('detail.pinned.no')
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.lastInference')}</DescriptionListTerm>
          <DescriptionListDescription>
            {model.lastInferenceAt ? (
              <>
                {formatRelativeTime(model.lastInferenceAt)}{' '}
                <span style={{ color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}>
                  ({formatDateTime(model.lastInferenceAt)})
                </span>
              </>
            ) : (
              t('detail.neverInferred')
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.created')}</DescriptionListTerm>
          <DescriptionListDescription>{formatDateTime(model.createdAt)}</DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>

      {/* Instances table (#120): each row is one runtime replica of this model — its own
          placement, endpoint, and lifecycle state. The model-level `state` above is the
          aggregate across these rows. */}
      <div style={{ marginBottom: 'var(--pf-t--global--spacer--lg)' }}>
        <Title
          headingLevel="h2"
          size="md"
          style={{ marginBottom: 'var(--pf-t--global--spacer--sm)' }}
        >
          {t('detail.instances.title')}
        </Title>
        {instances.length === 0 ? (
          <Content component="small">{t('detail.instances.empty')}</Content>
        ) : (
          <Table aria-label={t('detail.instances.title')} variant="compact">
            <Thead>
              <Tr>
                <Th>{t('detail.instances.columns.instanceId')}</Th>
                <Th>{t('detail.instances.columns.state')}</Th>
                <Th>{t('detail.instances.columns.worker')}</Th>
                <Th>{t('detail.instances.columns.endpoint')}</Th>
                <Th>{t('detail.instances.columns.created')}</Th>
                {isAdmin && <Th aria-label={t('detail.instances.columns.actions')} />}
              </Tr>
            </Thead>
            <Tbody>
              {instances.map((instance) => {
                const instanceEndpointText =
                  instance.runnerEndpoint?.host && instance.runnerEndpoint.port
                    ? `${instance.runnerEndpoint.host}:${instance.runnerEndpoint.port}`
                    : (instance.runnerEndpoint?.host ?? '—');
                const canSleep = instance.state === ModelLifecycleState.ACTIVE;
                const canWake = instance.state === ModelLifecycleState.SLEEPING;

                return (
                  <Tr key={instance.instanceId}>
                    <Td dataLabel={t('detail.instances.columns.instanceId')}>
                      <code style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}>
                        {instance.instanceId}
                      </code>
                    </Td>
                    <Td dataLabel={t('detail.instances.columns.state')}>
                      <StateLabel state={instance.state} isCompact />
                    </Td>
                    <Td dataLabel={t('detail.instances.columns.worker')}>
                      {instance.workerId ? (
                        <Link to={`/workers/${encodeURIComponent(instance.workerId)}`}>
                          {instance.workerId}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </Td>
                    <Td dataLabel={t('detail.instances.columns.endpoint')}>
                      {instanceEndpointText}
                    </Td>
                    <Td dataLabel={t('detail.instances.columns.created')}>
                      {instance.createdAt ? formatDateTime(instance.createdAt) : '—'}
                    </Td>
                    {isAdmin && (
                      <Td dataLabel={t('detail.instances.columns.actions')} isActionCell>
                        <Flex gap={{ default: 'gapSm' }}>
                          {canSleep && (
                            <FlexItem>
                              <Button
                                variant="secondary"
                                onClick={() => handleSleepInstance(instance.instanceId)}
                                isLoading={
                                  sleepInstance.isPending &&
                                  sleepInstance.variables?.instanceId === instance.instanceId
                                }
                              >
                                {t('detail.instance.sleep.button')}
                              </Button>
                            </FlexItem>
                          )}
                          {canWake && (
                            <FlexItem>
                              <Button
                                variant="primary"
                                onClick={() => handleWakeInstance(instance.instanceId)}
                                isLoading={
                                  wakeInstance.isPending &&
                                  wakeInstance.variables?.instanceId === instance.instanceId
                                }
                              >
                                {t('detail.instance.wake.button')}
                              </Button>
                            </FlexItem>
                          )}
                          <FlexItem>
                            <Button
                              variant="danger"
                              onClick={() => setDeleteInstanceId(instance.instanceId)}
                            >
                              {t('detail.instance.delete.button')}
                            </Button>
                          </FlexItem>
                        </Flex>
                      </Td>
                    )}
                  </Tr>
                );
              })}
            </Tbody>
          </Table>
        )}
      </div>

      {/* Engine config expandable */}
      {engineConfigJson && (
        <ExpandableSection
          toggleText={
            engineConfigExpanded ? t('detail.engineConfig.hide') : t('detail.engineConfig.show')
          }
          isExpanded={engineConfigExpanded}
          onToggle={(_ev, expanded) => setEngineConfigExpanded(expanded)}
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          <CodeBlock>
            <CodeBlockCode>{engineConfigJson}</CodeBlockCode>
          </CodeBlock>
        </ExpandableSection>
      )}

      {/* Sleep confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={showSleepModal}
        onClose={() => setShowSleepModal(false)}
        aria-label={t('detail.sleep.confirmTitle')}
      >
        <ModalHeader title={t('detail.sleep.confirmTitle')} titleIconVariant="warning" />
        <ModalBody>{t('detail.sleep.confirmBody', { modelName: model.modelName })}</ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleSleepConfirm} isLoading={sleepModel.isPending}>
            {t('detail.sleep.button')}
          </Button>
          <Button variant="link" onClick={() => setShowSleepModal(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Stop confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={showStopModal}
        onClose={() => setShowStopModal(false)}
        aria-label={t('detail.stop.confirmTitle')}
      >
        <ModalHeader title={t('detail.stop.confirmTitle')} titleIconVariant="warning" />
        <ModalBody>{t('detail.stop.confirmBody', { modelName: model.modelName })}</ModalBody>
        <ModalFooter>
          <Button variant="primary" onClick={handleStopConfirm} isLoading={stopModel.isPending}>
            {t('detail.stop.button')}
          </Button>
          <Button variant="link" onClick={() => setShowStopModal(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        aria-label={t('detail.delete.confirmTitle')}
      >
        <ModalHeader title={t('detail.delete.confirmTitle')} titleIconVariant="danger" />
        <ModalBody>{t('detail.delete.confirmBody', { modelName: model.modelName })}</ModalBody>
        <ModalFooter>
          <Button variant="danger" onClick={handleDeleteConfirm} isLoading={deleteModel.isPending}>
            {t('detail.delete.button')}
          </Button>
          <Button variant="link" onClick={() => setShowDeleteModal(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete instance confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={deleteInstanceId !== null}
        onClose={() => setDeleteInstanceId(null)}
        aria-label={t('detail.instance.delete.confirmTitle')}
      >
        <ModalHeader title={t('detail.instance.delete.confirmTitle')} titleIconVariant="danger" />
        <ModalBody>
          {t('detail.instance.delete.confirmBody', { instanceId: deleteInstanceId })}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={handleDeleteInstanceConfirm}
            isLoading={deleteInstance.isPending}
          >
            {t('detail.instance.delete.button')}
          </Button>
          <Button variant="link" onClick={() => setDeleteInstanceId(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>

      {/* Live logs modal */}
      {showLogsModal && (
        <DeployLogsModal
          modelName={model.modelName}
          isOpen={showLogsModal}
          onClose={() => setShowLogsModal(false)}
        />
      )}
    </PageSection>
  );
}
