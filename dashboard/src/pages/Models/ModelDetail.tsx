import { useState } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
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
import { LockIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import { useModel, useSleepModel, useWakeModel, useDeleteModel } from '../../hooks/useModels';
import { ApiError } from '../../api/client';
import { StateLabel } from '../../components/StateLabel';
import { formatBytes, formatRelativeTime, formatDateTime } from '../../utils/format';

export function ModelDetail() {
  const { modelName } = useParams<{ modelName: string }>();
  const navigate = useNavigate();

  const { data: model, isLoading, error } = useModel(modelName ?? '');
  const sleepModel = useSleepModel();
  const wakeModel = useWakeModel();
  const deleteModel = useDeleteModel();

  const [showSleepModal, setShowSleepModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [engineConfigExpanded, setEngineConfigExpanded] = useState(false);

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

  // Loading state
  if (isLoading) {
    return (
      <PageSection>
        <Spinner aria-label="Loading model details" />
      </PageSection>
    );
  }

  // 404 state
  if (error instanceof ApiError && error.status === 404) {
    return (
      <PageSection>
        <Alert variant={AlertVariant.warning} title="Model not found" isInline>
          No model named <strong>{modelName}</strong> exists.{' '}
          <Link to="/models">Back to models</Link>
        </Alert>
      </PageSection>
    );
  }

  // Generic error state
  if (error || !model) {
    return (
      <PageSection>
        <Alert variant={AlertVariant.danger} title="Failed to load model" isInline>
          {error instanceof Error ? error.message : 'Unknown error'}
        </Alert>
      </PageSection>
    );
  }

  const isActive = model.state === ModelLifecycleState.ACTIVE;
  const isSleeping = model.state === ModelLifecycleState.SLEEPING;
  const isError = model.state === ModelLifecycleState.ERROR;
  const isStarting = model.state === ModelLifecycleState.STARTING;

  const runnerEndpointText =
    model.runnerEndpoint?.host && model.runnerEndpoint.port
      ? `${model.runnerEndpoint.host}:${model.runnerEndpoint.port}`
      : model.runnerEndpoint?.host
        ? model.runnerEndpoint.host
        : '—';

  const engineConfigJson = model.engineConfig
    ? JSON.stringify(model.engineConfig, null, 2)
    : null;

  return (
    <PageSection>
      {/* Breadcrumb */}
      <Breadcrumb style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
        <BreadcrumbItem>
          <Link to="/">Cluster</Link>
        </BreadcrumbItem>
        <BreadcrumbItem>
          <Link to="/models">Models</Link>
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
        <FlexItem align={{ default: 'alignRight' }}>
          <Flex gap={{ default: 'gapSm' }}>
            {isActive && (
              <FlexItem>
                <Button variant="secondary" onClick={() => setShowSleepModal(true)}>
                  Sleep
                </Button>
              </FlexItem>
            )}
            {(isSleeping || isError) && (
              <FlexItem>
                <Button
                  variant="primary"
                  onClick={handleWake}
                  isLoading={wakeModel.isPending}
                >
                  Wake
                </Button>
              </FlexItem>
            )}
            <FlexItem>
              <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                Delete
              </Button>
            </FlexItem>
          </Flex>
        </FlexItem>
      </Flex>

      {/* Mutation error */}
      {mutationError && (
        <Alert
          variant={AlertVariant.danger}
          title="Action failed"
          isInline
          actionClose={
            <Button
              variant="plain"
              onClick={() => setMutationError(null)}
              aria-label="Close alert"
            />
          }
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
        >
          {mutationError}
        </Alert>
      )}

      {/* ERROR alert */}
      {isError && model.errorMessage && (
        <Alert
          variant={AlertVariant.danger}
          title="Model error"
          isInline
          style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          actionLinks={
            <Flex gap={{ default: 'gapSm' }}>
              <FlexItem>
                <Button
                  variant="secondary"
                  onClick={handleWake}
                  isLoading={wakeModel.isPending}
                >
                  Retry
                </Button>
              </FlexItem>
              <FlexItem>
                <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                  Delete
                </Button>
              </FlexItem>
            </Flex>
          }
        >
          {model.errorMessage}
        </Alert>
      )}

      {/* STARTING progress */}
      {isStarting && model.progress && (
        <div style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
          <Progress
            aria-label="Model loading progress"
            value={model.progress.percentComplete ?? 0}
            title={model.progress.phase ? `Phase: ${model.progress.phase}` : 'Loading…'}
          />
          {model.progress.message && (
            <Content
              component="small"
              style={{
                display: 'block',
                marginTop: 'var(--pf-t--global--spacer--sm)',
                color: 'var(--pf-t--global--color--nonstatus--gray--default)',
              }}
            >
              {model.progress.message}
              {model.progress.estimatedRemainingSeconds != null &&
                ` — ~${model.progress.estimatedRemainingSeconds}s remaining`}
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
          <DescriptionListTerm>State</DescriptionListTerm>
          <DescriptionListDescription>
            <StateLabel state={model.state} />
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Runner Type</DescriptionListTerm>
          <DescriptionListDescription>{model.runnerType}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Model Path</DescriptionListTerm>
          <DescriptionListDescription>
            <code style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}>
              {model.modelPath}
            </code>
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Worker</DescriptionListTerm>
          <DescriptionListDescription>
            {model.workerId ? (
              <Link to={`/workers/${encodeURIComponent(model.workerId)}`}>
                {model.workerId}
              </Link>
            ) : (
              '—'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Runner Endpoint</DescriptionListTerm>
          <DescriptionListDescription>{runnerEndpointText}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Required Memory</DescriptionListTerm>
          <DescriptionListDescription>
            {formatBytes(model.requiredMemory)}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Current Memory</DescriptionListTerm>
          <DescriptionListDescription>
            {model.currentMemory != null ? formatBytes(model.currentMemory) : '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Device Type</DescriptionListTerm>
          <DescriptionListDescription>{model.deviceType ?? '—'}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Tensor Parallelism</DescriptionListTerm>
          <DescriptionListDescription>
            {model.tensorParallel != null ? model.tensorParallel : '—'}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Pinned</DescriptionListTerm>
          <DescriptionListDescription>
            {model.pinned ? (
              <Flex gap={{ default: 'gapXs' }} alignItems={{ default: 'alignItemsCenter' }}>
                <FlexItem>
                  <LockIcon aria-hidden />
                </FlexItem>
                <FlexItem>Yes</FlexItem>
              </Flex>
            ) : (
              'No'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Last Inference</DescriptionListTerm>
          <DescriptionListDescription>
            {model.lastInferenceAt ? (
              <>
                {formatRelativeTime(model.lastInferenceAt)}
                {' '}
                <span
                  style={{ color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}
                >
                  ({formatDateTime(model.lastInferenceAt)})
                </span>
              </>
            ) : (
              'Never'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>State Changed</DescriptionListTerm>
          <DescriptionListDescription>
            {model.stateChangedAt ? (
              <>
                {formatRelativeTime(model.stateChangedAt)}
                {' '}
                <span
                  style={{ color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}
                >
                  ({formatDateTime(model.stateChangedAt)})
                </span>
              </>
            ) : (
              '—'
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>Created</DescriptionListTerm>
          <DescriptionListDescription>
            {formatDateTime(model.createdAt)}
          </DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>

      {/* Engine config expandable */}
      {engineConfigJson && (
        <ExpandableSection
          toggleText={engineConfigExpanded ? 'Hide engine config' : 'Show engine config'}
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
        aria-label="Confirm sleep"
      >
        <ModalHeader title="Put model to sleep?" titleIconVariant="warning" />
        <ModalBody>
          This will put <strong>{model.modelName}</strong> to sleep, freeing its device memory.
          It can be woken back up on demand.
        </ModalBody>
        <ModalFooter>
          <Button
            variant="primary"
            onClick={handleSleepConfirm}
            isLoading={sleepModel.isPending}
          >
            Sleep
          </Button>
          <Button variant="link" onClick={() => setShowSleepModal(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>

      {/* Delete confirmation modal */}
      <Modal
        variant={ModalVariant.small}
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        aria-label="Confirm delete"
      >
        <ModalHeader title="Delete model?" titleIconVariant="danger" />
        <ModalBody>
          This will permanently delete <strong>{model.modelName}</strong> and remove it from the
          cluster. This action cannot be undone.
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={handleDeleteConfirm}
            isLoading={deleteModel.isPending}
          >
            Delete
          </Button>
          <Button variant="link" onClick={() => setShowDeleteModal(false)}>
            Cancel
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
