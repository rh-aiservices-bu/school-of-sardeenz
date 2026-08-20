import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Modal,
  ModalVariant,
  ModalHeader,
  ModalBody,
  ModalFooter,
  Button,
  Breadcrumb,
  BreadcrumbItem,
  Label,
  Spinner,
  Alert,
  AlertVariant,
  EmptyState,
  EmptyStateBody,
  Flex,
  FlexItem,
} from '@patternfly/react-core';
import { FolderIcon, CubesIcon } from '@patternfly/react-icons';
import { useWeights } from '../../hooks/useWeights';

interface WeightsBrowserModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (absolutePath: string) => void;
}

// Joins a parent relative path with a child directory name (parent may be '').
function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function WeightsBrowserModal({ isOpen, onClose, onSelect }: WeightsBrowserModalProps) {
  const { t } = useTranslation('models');
  const { t: tCommon } = useTranslation('common');
  const [relativePath, setRelativePath] = useState('');
  const { data, isLoading, isError, error } = useWeights(relativePath, isOpen);

  // Breadcrumb segments (cumulative relative paths) for the current location.
  const crumbs = useMemo(() => {
    if (!relativePath) return [];
    const parts = relativePath.split('/');
    return parts.map((name, i) => ({ name, path: parts.slice(0, i + 1).join('/') }));
  }, [relativePath]);

  const select = (absolutePath: string) => {
    onSelect(absolutePath);
    onClose();
  };

  const entries = data?.entries ?? [];

  return (
    <Modal
      variant={ModalVariant.medium}
      isOpen={isOpen}
      onClose={onClose}
      aria-label={t('deploy.browse.title')}
    >
      <ModalHeader title={t('deploy.browse.title')} />
      <ModalBody>
        <Breadcrumb style={{ marginBottom: 'var(--pf-t--global--spacer--md)' }}>
          <BreadcrumbItem
            component="button"
            isActive={crumbs.length === 0}
            onClick={() => setRelativePath('')}
          >
            {t('deploy.browse.root')}
          </BreadcrumbItem>
          {crumbs.map((crumb, i) => (
            <BreadcrumbItem
              key={crumb.path}
              component="button"
              isActive={i === crumbs.length - 1}
              onClick={() => setRelativePath(crumb.path)}
            >
              {crumb.name}
            </BreadcrumbItem>
          ))}
        </Breadcrumb>

        {isLoading && <Spinner size="lg" aria-label={tCommon('loading')} />}

        {isError && (
          <Alert
            variant={AlertVariant.danger}
            isInline
            title={t('deploy.browse.error')}
          >
            {error instanceof Error ? error.message : tCommon('errors.unexpected')}
          </Alert>
        )}

        {!isLoading && !isError && entries.length === 0 && (
          <EmptyState titleText={t('deploy.browse.empty')} icon={FolderIcon} headingLevel="h4">
            <EmptyStateBody>{t('deploy.browse.emptyBody')}</EmptyStateBody>
          </EmptyState>
        )}

        {!isLoading && !isError && entries.length > 0 && (
          <div role="list">
            {entries.map((entry) => (
              <Flex
                key={entry.path}
                role="listitem"
                alignItems={{ default: 'alignItemsCenter' }}
                style={{
                  padding: 'var(--pf-t--global--spacer--sm) 0',
                  borderBottom: '1px solid var(--pf-t--global--border--color--default)',
                }}
              >
                <FlexItem>
                  <Button
                    variant="link"
                    isInline
                    icon={entry.isModelDir ? <CubesIcon /> : <FolderIcon />}
                    onClick={() => setRelativePath(childPath(relativePath, entry.name))}
                  >
                    {entry.name}
                  </Button>
                </FlexItem>
                {entry.isModelDir && (
                  <FlexItem>
                    <Label color="green">{t('deploy.browse.modelLabel')}</Label>
                  </FlexItem>
                )}
                <FlexItem align={{ default: 'alignRight' }}>
                  <Button variant="secondary" onClick={() => select(entry.path)}>
                    {t('deploy.browse.select')}
                  </Button>
                </FlexItem>
              </Flex>
            ))}
          </div>
        )}
      </ModalBody>
      <ModalFooter>
        <Button
          variant="primary"
          isDisabled={!data}
          onClick={() => data && select(data.path)}
        >
          {t('deploy.browse.selectCurrent')}
        </Button>
        <Button variant="link" onClick={onClose}>
          {tCommon('actions.cancel')}
        </Button>
      </ModalFooter>
    </Modal>
  );
}
