import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Alert,
  AlertVariant,
  Spinner,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { StartupLogSessionOutcome } from '@sardeenz/types';
import { useModel } from '../hooks/useModels';
import { useModelLogs } from '../hooks/useModelLogs';
import { useStartupLogSessions } from '../hooks/useModels';
import { StateLabel } from './StateLabel';
import { LogViewer } from './LogViewer';

interface DeployLogsModalProps {
  modelName: string;
  instanceId: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Auto-opens on deploy (and reusable as a "View starting logs" action) to stream a runner's
 * startup logs. Flips to a success or failure state as the model's lifecycle state changes.
 *
 * The modal never closes itself — the operator closes it manually. Startup can take minutes, and
 * the worker ends the log stream (see RunnerLogBuffer) once the engine finishes loading, so live
 * output stops on its own; the buffered startup logs stay viewable if the modal is reopened later.
 * The "model available" notification + state change come from the control plane on the real ACTIVE
 * transition, so an operator who closed the modal is still told when the model is actually up.
 */
export function DeployLogsModal({ modelName, instanceId, isOpen, onClose }: DeployLogsModalProps) {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const { data: model } = useModel(modelName);
  const { data: sessions } = useStartupLogSessions(modelName);
  const { logs, isConnected, failed } = useModelLogs(modelName, instanceId, isOpen);
  const instance = model?.instances.find((candidate) => candidate.instanceId === instanceId);
  const session = sessions?.find((candidate) => candidate.instanceId === instanceId);

  const isActive = session?.outcome === StartupLogSessionOutcome.SUCCEEDED;
  const isError = session?.outcome === StartupLogSessionOutcome.FAILED;
  const isStarting = !session || session.outcome === StartupLogSessionOutcome.IN_PROGRESS;
  const errorMessage = session?.errorMessage ?? instance?.errorMessage;

  return (
    <Modal
      variant={ModalVariant.large}
      isOpen={isOpen}
      onClose={onClose}
      aria-label={t('logs.modalTitle')}
    >
      <ModalHeader
        title={t('logs.modalTitle')}
        titleIconVariant={isError ? 'danger' : isActive ? 'success' : undefined}
        description={
          <Flex alignItems={{ default: 'alignItemsCenter' }} gap={{ default: 'gapSm' }}>
            <FlexItem>
              <code style={{ fontFamily: 'var(--pf-t--global--font--family--mono)' }}>
                {modelName} / {instanceId}
              </code>
            </FlexItem>
            {instance && (
              <FlexItem>
                <StateLabel state={instance.state} isCompact />
              </FlexItem>
            )}
          </Flex>
        }
      />
      <ModalBody>
        {isStarting && (
          <Flex
            alignItems={{ default: 'alignItemsCenter' }}
            gap={{ default: 'gapSm' }}
            style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          >
            <FlexItem>
              <Spinner size="md" aria-label={t('logs.startingProgress')} />
            </FlexItem>
            <FlexItem>{t('logs.startingProgress')}</FlexItem>
          </Flex>
        )}

        {isActive && (
          <Alert
            variant={AlertVariant.success}
            title={t('logs.successTitle')}
            isInline
            style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          >
            {t('logs.successBody')}
          </Alert>
        )}

        {isError && (
          <Alert
            variant={AlertVariant.danger}
            title={t('logs.failureTitle')}
            isInline
            style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}
          >
            {errorMessage ?? t('logs.failureBodyFallback')}
          </Alert>
        )}

        <LogViewer logs={logs} isConnected={isConnected} failed={failed} />
      </ModalBody>
      <ModalFooter>
        <Button variant={isActive || isError ? 'primary' : 'secondary'} onClick={onClose}>
          {tCommon('actions.close')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
