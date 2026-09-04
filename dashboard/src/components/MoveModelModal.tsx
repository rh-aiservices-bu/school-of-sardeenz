import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Checkbox,
  Form,
  FormGroup,
  FormSelect,
  FormSelectOption,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  Spinner,
} from '@patternfly/react-core';
import { WorkerStatus } from '@sardeenz/types';
import { useMoveInstance, useModel } from '../hooks/useModels';
import { useRunnerTypes, useWorkerCapabilities, useWorkers } from '../hooks/useWorkers';
import { classifyMoveProgress, type MoveProgress } from '../utils/move';

export interface MoveSource {
  modelName: string;
  instanceId: string;
  workerId: string;
  deviceIndices: number[];
}

export function MoveModelModal({
  source,
  onClose,
}: {
  source: MoveSource | null;
  onClose: () => void;
}) {
  const { t } = useTranslation('models');
  const { data: detail } = useModel(source?.modelName ?? '');
  const { data: workers } = useWorkers();
  const { capabilities, isFallback: capabilitiesFallback } = useWorkerCapabilities();
  const { options: runnerTypes } = useRunnerTypes();
  const move = useMoveInstance();
  const [workerId, setWorkerId] = useState('');
  const [devices, setDevices] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [moveIds, setMoveIds] = useState<{ source: string; replacement: string } | null>(null);
  const isOpen = source !== null;
  const tensorParallel = detail?.tensorParallel ?? source?.deviceIndices.length ?? 1;
  const target = workers?.find((worker) => worker.workerId === workerId);
  const compatible = useMemo(() => {
    if (!target || !detail) return [];
    const supportsRunner = target.runnerCapabilities?.some(
      (capability) =>
        capability.runnerType === detail.runnerType &&
        (!detail.deviceType ||
          capability.supportedDeviceTypes.includes(detail.deviceType as never)),
    );
    const runnerKnown =
      capabilitiesFallback ||
      (capabilities.some((capability) => capability.runnerType === detail.runnerType) &&
        runnerTypes.some((option) => option.value === detail.runnerType));
    return supportsRunner && runnerKnown
      ? target.devices.filter(
          (device) => !detail.deviceType || device.deviceType === detail.deviceType,
        )
      : [];
  }, [capabilities, capabilitiesFallback, detail, runnerTypes, target]);

  useEffect(() => {
    if (!source) return;
    setWorkerId('');
    setDevices([]);
    setError(null);
    setMoveIds(null);
  }, [source]);
  useEffect(
    () =>
      setDevices((selected) =>
        selected.filter((id) => compatible.some((device) => device.deviceIndex === id)),
      ),
    [compatible],
  );

  const submit = () => {
    if (!source || devices.length !== tensorParallel) return;
    setError(null);
    move.mutate(
      {
        modelName: source.modelName,
        instanceId: source.instanceId,
        targetWorkerId: workerId,
        targetDeviceIndices: devices,
      },
      {
        onSuccess: (result) =>
          setMoveIds({
            source: result.sourceInstanceId,
            replacement: result.replacementInstanceId,
          }),
        onError: (err) => setError(err instanceof Error ? err.message : String(err)),
      },
    );
  };
  const toggleDevice = (deviceIndex: number, checked: boolean) =>
    setDevices((current) =>
      checked ? [...current, deviceIndex] : current.filter((index) => index !== deviceIndex),
    );

  return (
    <Modal
      variant={ModalVariant.small}
      isOpen={isOpen}
      onClose={onClose}
      aria-label={t('move.title')}
    >
      <ModalHeader title={t('move.title')} />
      <ModalBody>
        <p>{t('move.description', { instanceId: source?.instanceId })}</p>
        {error && (
          <Alert variant="danger" isInline title={t('move.failed')}>
            {error}
          </Alert>
        )}
        {moveIds && (
          <MoveProgressAlert
            progress={classifyMoveProgress(detail?.instances, moveIds.source, moveIds.replacement)}
          />
        )}
        {!detail || !workers ? (
          <Spinner aria-label={t('move.loading')} />
        ) : (
          <Form>
            <FormGroup label={t('move.worker')} fieldId="move-worker">
              <FormSelect
                id="move-worker"
                value={workerId}
                onChange={(_event, value) => setWorkerId(value)}
              >
                <FormSelectOption value="" label={t('move.selectWorker')} isPlaceholder />
                {workers
                  .filter((worker) => worker.status === WorkerStatus.ONLINE)
                  .map((worker) => (
                    <FormSelectOption
                      key={worker.workerId}
                      value={worker.workerId}
                      label={worker.workerId}
                    />
                  ))}
              </FormSelect>
            </FormGroup>
            <FormGroup label={t('move.devices', { count: tensorParallel })} fieldId="move-devices">
              {compatible.map((device) => (
                <Checkbox
                  key={device.deviceIndex}
                  id={`move-device-${device.deviceIndex}`}
                  label={`${t('move.gpu')} ${device.deviceIndex}`}
                  isChecked={devices.includes(device.deviceIndex)}
                  onChange={(_event, checked) => toggleDevice(device.deviceIndex, checked)}
                />
              ))}
              {workerId && compatible.length === 0 && (
                <Alert variant="warning" isInline title={t('move.noCompatibleDevices')} />
              )}
            </FormGroup>
          </Form>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          onClick={submit}
          isLoading={move.isPending}
          isDisabled={!!moveIds || !workerId || devices.length !== tensorParallel || move.isPending}
        >
          {t('move.submit')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t(moveIds ? 'move.close' : 'move.cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}

function MoveProgressAlert({ progress }: { progress: MoveProgress }) {
  const { t } = useTranslation('models');
  const variant =
    progress.includes('failed') || progress === 'unavailable'
      ? 'danger'
      : progress === 'complete'
        ? 'success'
        : 'info';
  return <Alert variant={variant} isInline title={t(`move.progress.${progress}`)} />;
}
