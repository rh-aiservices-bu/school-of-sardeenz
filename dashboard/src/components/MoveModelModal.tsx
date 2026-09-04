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
  const [moveIds, setMoveIds] = useState<{
    source: string;
    replacement: string;
    acceptedAt: number;
  } | null>(null);
  const [replacementWasObserved, setReplacementWasObserved] = useState(false);
  const isOpen = source !== null;
  const tensorParallel = detail?.tensorParallel ?? source?.deviceIndices.length ?? 1;
  const target = workers?.find((worker) => worker.workerId === workerId);
  const perDeviceRequired = (detail?.requiredMemory ?? 0) / tensorParallel;
  const compatible = useMemo(() => {
    if (!target || !detail) return [];
    const capability = target.runnerCapabilities?.find(
      (capability) =>
        capability.runnerType === detail.runnerType &&
        capability.maxTensorParallelism >= tensorParallel &&
        (!detail.deviceType ||
          capability.supportedDeviceTypes.includes(detail.deviceType as never)),
    );
    const runnerKnown =
      capabilitiesFallback ||
      (capabilities.some((capability) => capability.runnerType === detail.runnerType) &&
        runnerTypes.some((option) => option.value === detail.runnerType));
    return capability && runnerKnown
      ? target.devices.filter(
          (device) =>
            (!detail.deviceType || device.deviceType === detail.deviceType) &&
            capability.supportedDeviceTypes.includes(device.deviceType as never) &&
            device.memoryAvailableBytes >= perDeviceRequired,
        )
      : [];
  }, [
    capabilities,
    capabilitiesFallback,
    detail,
    perDeviceRequired,
    runnerTypes,
    target,
    tensorParallel,
  ]);
  const eligibleWorkers = useMemo(
    () =>
      workers?.filter((worker) => {
        if (worker.status !== WorkerStatus.ONLINE || !detail || !source) return false;
        const capability = worker.runnerCapabilities?.find(
          (candidate) =>
            candidate.runnerType === detail.runnerType &&
            candidate.maxTensorParallelism >= tensorParallel,
        );
        if (!capability) return false;
        const eligibleCount = worker.devices.filter(
          (device) =>
            (!detail.deviceType || device.deviceType === detail.deviceType) &&
            capability.supportedDeviceTypes.includes(device.deviceType as never) &&
            device.memoryAvailableBytes >= perDeviceRequired,
        ).length;
        const isSamePlacement =
          worker.workerId === source.workerId &&
          source.deviceIndices.length === tensorParallel &&
          source.deviceIndices.every((index) => devices.includes(index));
        return eligibleCount >= tensorParallel && !isSamePlacement;
      }) ?? [],
    [detail, devices, perDeviceRequired, source, tensorParallel, workers],
  );
  const isIdenticalPlacement =
    !!source &&
    workerId === source.workerId &&
    devices.length === source.deviceIndices.length &&
    source.deviceIndices.every((index) => devices.includes(index));

  useEffect(() => {
    if (!source) return;
    setWorkerId('');
    setDevices([]);
    setError(null);
    setMoveIds(null);
    setReplacementWasObserved(false);
  }, [source]);
  useEffect(
    () =>
      setDevices((selected) =>
        selected.filter((id) => compatible.some((device) => device.deviceIndex === id)),
      ),
    [compatible],
  );
  useEffect(() => {
    if (
      moveIds &&
      detail?.instances.some((instance) => instance.instanceId === moveIds.replacement)
    ) {
      setReplacementWasObserved(true);
    }
  }, [detail?.instances, moveIds]);

  const submit = () => {
    if (!source || devices.length !== tensorParallel || isIdenticalPlacement) return;
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
            acceptedAt: Date.now(),
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
      aria-label={t('detail.move.title')}
    >
      <ModalHeader title={t('detail.move.title')} />
      <ModalBody>
        <p>{t('detail.move.description', { instanceId: source?.instanceId })}</p>
        {error && (
          <Alert variant="danger" isInline title={t('detail.move.failed')}>
            {error}
          </Alert>
        )}
        {moveIds && (
          <MoveProgressAlert
            progress={classifyMoveProgress(
              detail?.instances,
              moveIds.source,
              moveIds.replacement,
              replacementWasObserved,
              moveIds.acceptedAt,
            )}
          />
        )}
        {!detail || !workers ? (
          <Spinner aria-label={t('detail.move.loading')} />
        ) : (
          <Form>
            <FormGroup label={t('detail.move.worker')} fieldId="move-worker">
              <FormSelect
                id="move-worker"
                value={workerId}
                onChange={(_event, value) => setWorkerId(value)}
              >
                <FormSelectOption value="" label={t('detail.move.selectWorker')} isPlaceholder />
                {eligibleWorkers.map((worker) => (
                  <FormSelectOption
                    key={worker.workerId}
                    value={worker.workerId}
                    label={worker.workerId}
                  />
                ))}
              </FormSelect>
            </FormGroup>
            <FormGroup
              label={t('detail.move.devices', { count: tensorParallel })}
              fieldId="move-devices"
            >
              <div
                id="move-devices"
                role="group"
                aria-label={t('detail.move.devices', { count: tensorParallel })}
              >
                {compatible.map((device) => (
                  <Checkbox
                    key={device.deviceIndex}
                    id={`move-device-${device.deviceIndex}`}
                    label={`${t('detail.move.gpu')} ${device.deviceIndex}`}
                    isChecked={devices.includes(device.deviceIndex)}
                    onChange={(_event, checked) => toggleDevice(device.deviceIndex, checked)}
                  />
                ))}
              </div>
              {workerId && compatible.length === 0 && (
                <Alert variant="warning" isInline title={t('detail.move.noCompatibleDevices')} />
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
          isDisabled={
            !!moveIds ||
            !workerId ||
            devices.length !== tensorParallel ||
            isIdenticalPlacement ||
            move.isPending
          }
        >
          {t('detail.move.submit')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {t(moveIds ? 'detail.move.close' : 'detail.move.cancel')}
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
  return <Alert variant={variant} isInline title={t(`detail.move.progress.${progress}`)} />;
}
