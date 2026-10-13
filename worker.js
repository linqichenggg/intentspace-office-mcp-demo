import spaces from './demo-data/spaces.csv';
import reservations from './demo-data/reservations.csv';
import categories from './demo-data/reservations_classified_mapping.csv';
import { createDataset } from './queries.js';
import { handleCloudRequest } from './cloud-api.js';

// This deployment can only load the fictional fixtures, never enterprise data.
const data = createDataset({ 'spaces.csv': spaces, 'reservations.csv': reservations, 'reservations_classified_mapping.csv': categories }, 'synthetic');
export default {
  fetch(request, env) { return handleCloudRequest(request, env, data); },
};
