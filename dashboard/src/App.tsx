import { Routes, Route } from 'react-router-dom';
import { AppLayout } from './components/AppLayout';
import { ClusterOverview } from './pages/ClusterOverview/ClusterOverview';
import { ModelList } from './pages/Models/ModelList';
import { ModelDeploy } from './pages/Models/ModelDeploy';
import { ModelDetail } from './pages/Models/ModelDetail';
import { WorkerList } from './pages/Workers/WorkerList';
import { WorkerDetail } from './pages/Workers/WorkerDetail';
import { MetricsDashboard } from './pages/Metrics/MetricsDashboard';

export function App() {
  return (
    <AppLayout>
      <Routes>
        <Route path="/" element={<ClusterOverview />} />
        <Route path="/models" element={<ModelList />} />
        <Route path="/models/deploy" element={<ModelDeploy />} />
        <Route path="/models/:modelName" element={<ModelDetail />} />
        <Route path="/workers" element={<WorkerList />} />
        <Route path="/workers/:workerId" element={<WorkerDetail />} />
        <Route path="/metrics" element={<MetricsDashboard />} />
      </Routes>
    </AppLayout>
  );
}
