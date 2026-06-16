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
import { LockIcon } from '@patternfly/react-icons';
import { ModelLifecycleState } from '@sardeenz/types';
import { useModel, useSleepModel, useWakeModel, useDeleteModel } from '../../hooks/useModels';
import { ApiError } from '../../api/client';
import { StateLabel } from '../../components/StateLabel';
import { formatBytes, formatRelativeTime, formatDateTime } from '../../utils/format';

export function ModelDetail() {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
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
        <FlexItem align={{ default: 'alignRight' }}>
          <Flex gap={{ default: 'gapSm' }}>
            {isActive && (
              <FlexItem>
                <Button variant="secondary" onClick={() => setShowSleepModal(true)}>
                  {t('detail.sleep.button')}
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
                  {t('detail.wake.button')}
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
      {isError && model.errorMessage && (
        <Alert
          variant={AlertVariant.danger}
          title={t('detail.errors.modelError')}
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
                  {t('detail.wake.button')}
                </Button>
              </FlexItem>
              <FlexItem>
                <Button variant="danger" onClick={() => setShowDeleteModal(true)}>
                  {t('detail.delete.button')}
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
            aria-label={t('detail.fields.state')}
            value={model.progress.percentComplete ?? 0}
            title={model.progress.phase ? `${t('detail.progress.phasePrefix')}${model.progress.phase}` : tCommon('loading')}
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
                t('detail.progress.remainingSeconds', { seconds: model.progress.estimatedRemainingSeconds })}
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
          <DescriptionListTerm>{t('detail.fields.worker')}</DescriptionListTerm>
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
          <DescriptionListTerm>{t('detail.fields.runnerEndpoint')}</DescriptionListTerm>
          <DescriptionListDescription>{runnerEndpointText}</DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.requiredMemory')}</DescriptionListTerm>
          <DescriptionListDescription>
            {formatBytes(model.requiredMemory)}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.currentMemory')}</DescriptionListTerm>
          <DescriptionListDescription>
            {model.currentMemory != null ? formatBytes(model.currentMemory) : '—'}
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
                {formatRelativeTime(model.lastInferenceAt)}
                {' '}
                <span
                  style={{ color: 'var(--pf-t--global--color--nonstatus--gray--default)' }}
                >
                  ({formatDateTime(model.lastInferenceAt)})
                </span>
              </>
            ) : (
              t('detail.neverInferred')
            )}
          </DescriptionListDescription>
        </DescriptionListGroup>

        <DescriptionListGroup>
          <DescriptionListTerm>{t('detail.fields.stateChanged')}</DescriptionListTerm>
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
          <DescriptionListTerm>{t('detail.fields.created')}</DescriptionListTerm>
          <DescriptionListDescription>
            {formatDateTime(model.createdAt)}
          </DescriptionListDescription>
        </DescriptionListGroup>
      </DescriptionList>

      {/* Engine config expandable */}
      {engineConfigJson && (
        <ExpandableSection
          toggleText={engineConfigExpanded ? t('detail.engineConfig.hide') : t('detail.engineConfig.show')}
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
        <ModalBody>
          {t('detail.sleep.confirmBody', { modelName: model.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="primary"
            onClick={handleSleepConfirm}
            isLoading={sleepModel.isPending}
          >
            {t('detail.sleep.button')}
          </Button>
          <Button variant="link" onClick={() => setShowSleepModal(false)}>
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
        <ModalBody>
          {t('detail.delete.confirmBody', { modelName: model.modelName })}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            onClick={handleDeleteConfirm}
            isLoading={deleteModel.isPending}
          >
            {t('detail.delete.button')}
          </Button>
          <Button variant="link" onClick={() => setShowDeleteModal(false)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
