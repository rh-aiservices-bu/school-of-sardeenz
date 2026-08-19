import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Alert,
  Button,
  Card,
  CardBody,
  CardFooter,
  CardTitle,
  Content,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
  Gallery,
  Label,
  LabelGroup,
  Modal,
  ModalBody,
  ModalFooter,
  ModalHeader,
  ModalVariant,
  PageSection,
  Progress,
  ProgressSize,
  Spinner,
  Split,
  SplitItem,
  Stack,
  StackItem,
  Title,
  Toolbar,
  ToolbarContent,
  ToolbarItem,
} from '@patternfly/react-core';
import { CubesIcon, DownloadIcon, SyncAltIcon, TrashIcon } from '@patternfly/react-icons';
import { CatalogItemState } from '@sardeenz/types';
import type { CatalogItem } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import {
  useCatalog,
  useImportRunner,
  useRefreshCatalog,
  useUninstallRunner,
} from '../../hooks/useCatalog';

function stateLabel(item: CatalogItem, t: (k: string) => string) {
  switch (item.status.state) {
    case CatalogItemState.IMPORTED:
      return (
        <Label color="green" isCompact>
          {t('state.imported')}
        </Label>
      );
    case CatalogItemState.IMPORTING:
      return (
        <Label color="blue" isCompact>
          {t('state.importing')}
        </Label>
      );
    case CatalogItemState.FAILED:
      return (
        <Label color="red" isCompact>
          {t('state.failed')}
        </Label>
      );
    default:
      return (
        <Label color="grey" isCompact>
          {t('state.notImported')}
        </Label>
      );
  }
}

function RunnerCard({
  item,
  isAdmin,
  onImport,
  onUninstall,
  isImportPending,
  isUninstallPending,
}: {
  item: CatalogItem;
  isAdmin: boolean;
  onImport: (id: string) => void;
  onUninstall: (item: CatalogItem) => void;
  isImportPending: boolean;
  isUninstallPending: boolean;
}) {
  const { t } = useTranslation('catalog');
  const { entry, status } = item;
  const imported = status.state === CatalogItemState.IMPORTED;
  const importing = status.state === CatalogItemState.IMPORTING;

  return (
    <Card isCompact>
      <CardTitle>
        <Split hasGutter>
          <SplitItem isFilled>{entry.title}</SplitItem>
          <SplitItem>{stateLabel(item, t)}</SplitItem>
        </Split>
      </CardTitle>
      <CardBody>
        <Stack hasGutter>
          <StackItem>{entry.description}</StackItem>
          <StackItem>
            <LabelGroup numLabels={6}>
              {entry.engine && <Label isCompact>{entry.engine}</Label>}
              <Label isCompact>v{entry.version}</Label>
              {typeof entry.minVRAMGiB === 'number' && (
                <Label isCompact>{t('card.minVram', { gib: entry.minVRAMGiB })}</Label>
              )}
              {(entry.tags ?? []).map((tag) => (
                <Label key={tag} color="blue" isCompact variant="outline">
                  {tag}
                </Label>
              ))}
            </LabelGroup>
          </StackItem>
          {importing && (
            <StackItem>
              <Progress
                value={status.percentComplete ?? 0}
                size={ProgressSize.sm}
                title={t('state.importing')}
                aria-label={t('state.importing')}
              />
            </StackItem>
          )}
          {status.state === CatalogItemState.FAILED && status.error && (
            <StackItem>
              <Alert variant="danger" isInline isPlain title={status.error} />
            </StackItem>
          )}
        </Stack>
      </CardBody>
      {isAdmin && (
        <CardFooter>
          <Flex spaceItems={{ default: 'spaceItemsSm' }}>
            {!imported && (
              <FlexItem>
                <Button
                  variant="primary"
                  icon={<DownloadIcon />}
                  isDisabled={importing || isImportPending}
                  isLoading={importing || isImportPending}
                  onClick={() => onImport(entry.id)}
                >
                  {t('actions.import')}
                </Button>
              </FlexItem>
            )}
            {imported && (
              <FlexItem>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  isDisabled={isImportPending}
                  isLoading={isImportPending}
                  onClick={() => onImport(entry.id)}
                >
                  {t('actions.reimport')}
                </Button>
              </FlexItem>
            )}
            {imported && (
              <FlexItem>
                <Button
                  variant="secondary"
                  isDanger
                  icon={<TrashIcon />}
                  isDisabled={isUninstallPending}
                  onClick={() => onUninstall(item)}
                >
                  {t('actions.uninstall')}
                </Button>
              </FlexItem>
            )}
          </Flex>
        </CardFooter>
      )}
    </Card>
  );
}

export function RunnerCatalog() {
  const { t } = useTranslation('catalog');
  const { t: tCommon } = useTranslation('common');
  const { isAdmin } = useAuth();
  const { data, isLoading, error, isFetching } = useCatalog();
  const refresh = useRefreshCatalog();
  const importRunner = useImportRunner();
  const uninstallRunner = useUninstallRunner();
  const [confirmUninstall, setConfirmUninstall] = useState<CatalogItem | null>(null);

  if (isLoading) {
    return (
      <PageSection>
        <Flex justifyContent={{ default: 'justifyContentCenter' }}>
          <FlexItem>
            <Spinner size="xl" aria-label={t('title')} />
          </FlexItem>
        </Flex>
      </PageSection>
    );
  }

  if (error) {
    return (
      <PageSection>
        <Alert variant="danger" title={t('errors.failedToLoad')} isInline>
          <Content>{error instanceof Error ? error.message : tCommon('errors.unexpected')}</Content>
        </Alert>
      </PageSection>
    );
  }

  const runners = data?.runners ?? [];

  return (
    <PageSection>
      <Stack hasGutter>
        <StackItem>
          <Split hasGutter>
            <SplitItem isFilled>
              <Title headingLevel="h1" size="2xl">
                {t('title')}
              </Title>
            </SplitItem>
          </Split>
        </StackItem>
        <StackItem>
          <Toolbar>
            <ToolbarContent>
              <ToolbarItem>
                <Content component="small">
                  {data?.source ? t('source', { source: data.source }) : ''}
                </Content>
              </ToolbarItem>
              <ToolbarItem align={{ default: 'alignEnd' }}>
                <Button
                  variant="secondary"
                  icon={<SyncAltIcon />}
                  isLoading={refresh.isPending || isFetching}
                  isDisabled={refresh.isPending}
                  onClick={() => refresh.mutate()}
                >
                  {t('actions.refresh')}
                </Button>
              </ToolbarItem>
            </ToolbarContent>
          </Toolbar>
        </StackItem>

        {refresh.isError && (
          <StackItem>
            <Alert variant="warning" isInline title={t('errors.refreshFailed')}>
              {refresh.error instanceof Error ? refresh.error.message : ''}
            </Alert>
          </StackItem>
        )}

        {importRunner.isError && (
          <StackItem>
            <Alert variant="danger" isInline title={t('errors.importFailed')}>
              {importRunner.error instanceof Error ? importRunner.error.message : ''}
            </Alert>
          </StackItem>
        )}

        {uninstallRunner.isError && (
          <StackItem>
            <Alert variant="danger" isInline title={t('errors.uninstallFailed')}>
              {uninstallRunner.error instanceof Error ? uninstallRunner.error.message : ''}
            </Alert>
          </StackItem>
        )}

        <StackItem>
          {runners.length === 0 ? (
            <EmptyState headingLevel="h2" icon={CubesIcon} titleText={t('empty.title')}>
              <EmptyStateBody>{t('empty.body')}</EmptyStateBody>
            </EmptyState>
          ) : (
            <Gallery hasGutter minWidths={{ default: '320px' }}>
              {runners.map((item) => (
                <RunnerCard
                  key={item.entry.id}
                  item={item}
                  isAdmin={isAdmin}
                  onImport={(id) => importRunner.mutate(id)}
                  onUninstall={setConfirmUninstall}
                  isImportPending={
                    importRunner.isPending && importRunner.variables === item.entry.id
                  }
                  isUninstallPending={
                    uninstallRunner.isPending && uninstallRunner.variables === item.entry.id
                  }
                />
              ))}
            </Gallery>
          )}
        </StackItem>

        {(data?.unmanagedModules?.length ?? 0) > 0 && (
          <StackItem>
            <Content component="h2">{t('unmanaged.title')}</Content>
            <Content component="small">{t('unmanaged.body')}</Content>
            <LabelGroup numLabels={20}>
              {data?.unmanagedModules.map((m) => (
                <Label key={m} isCompact>
                  {m}
                </Label>
              ))}
            </LabelGroup>
          </StackItem>
        )}
      </Stack>

      <Modal
        variant={ModalVariant.small}
        isOpen={confirmUninstall !== null}
        onClose={() => setConfirmUninstall(null)}
        aria-label={t('uninstall.confirmTitle')}
      >
        <ModalHeader title={t('uninstall.confirmTitle')} titleIconVariant="warning" />
        <ModalBody>
          {t('uninstall.confirmBody', { title: confirmUninstall?.entry.title })}
        </ModalBody>
        <ModalFooter>
          <Button
            variant="danger"
            isLoading={uninstallRunner.isPending}
            onClick={() => {
              if (confirmUninstall) uninstallRunner.mutate(confirmUninstall.entry.id);
              setConfirmUninstall(null);
            }}
          >
            {t('actions.uninstall')}
          </Button>
          <Button variant="link" onClick={() => setConfirmUninstall(null)}>
            {tCommon('actions.cancel')}
          </Button>
        </ModalFooter>
      </Modal>
    </PageSection>
  );
}
