import { z } from 'zod';
import { CREATE_ANNOTATIONS, OVERWRITE_ANNOTATIONS, READ_ONLY_ANNOTATIONS, entity, key, list, pick, redactSecrets, requireConfirmation, top } from './integration-common.mjs';
import { IntegrationError } from './integration-http.mjs';
import { redactPrivateValues } from './apim-runtime.mjs';
import { createCollectionPager, cursorSchema } from './integration-collections.mjs';
import { registerDevhubRetirementTools } from './devhub-retirement.mjs';

const DATA = '/odata/1.0/data.svc';
const applicationId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_-]+$/);
const developerId = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.@-]+$/);
const productName = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,99}$/);
const confirmation = z.string().min(1);
const EMPTY_ID = '00000000000000000000000000000000';

function applicationSummary(value) {
  if (!value) return null;
  const cleaned = entity(value);
  const summary = {
    ...redactSecrets(pick(cleaned, ['id', 'title', 'description', 'version', 'callbackurl', 'developer_id', 'reg_id', 'status', 'status_code', 'valid_from', 'valid_to', 'ToSubscriptions', 'ToAPIProductsDetails'])),
    has_consumer_key: typeof cleaned.app_key === 'string' && cleaned.app_key.length > 0
  };
  return redactPrivateValues(summary, [cleaned.app_key, cleaned.app_secret]);
}

function applicationListSummary(value) {
  const application = entity(value);
  return redactPrivateValues(pick(application, ['id', 'title', 'version', 'status', 'status_code', 'valid_from', 'valid_to']),
    [application.app_key, application.app_secret]);
}

function developerListSummary(value) {
  return {
    ...pick(value, ['id', 'status']),
    roles: list(value.rolesAccess).map(role => pick(role, ['role', 'status']))
  };
}

/** Register Developer Hub tools; application credentials are never returned. */
export function registerDevhubTools(register, client, { readBackDelayMs } = {}) {
  const request = (method, path, options) => client.request(method, `${DATA}${path}`, options);
  const collections = createCollectionPager(client, { root: DATA, request });
  const registrations = createCollectionPager(client, { root: '/api/1.0' });
  registerDevhubRetirementTools(register, client, { readBackDelayMs });
  async function getApplication(id) {
    const { status, data } = await request('GET', `/APIMgmt.Applications(${key(id)})`, {
      query: { $expand: 'ToAPIProductsDetails,ToSubscriptions/ToAPIProduct,ToSubscriptions/ToRatePlan' },
      expect: [200, 404], withStatus: true
    });
    if (status === 404) throw new IntegrationError(`Developer Hub application ${id} does not exist`);
    return data;
  }

  register('devhub_list_developers', 'List Developer Hub developers',
    'List registered Developer Hub role/status metadata without personal details or credentials. Requires a Developer Hub API-access service key.',
    { top: top(), cursor: cursorSchema }, READ_ONLY_ANNOTATIONS,
    async args => registrations.page({
      ...args, path: '/registrations', query: { type: 'registered' }, mode: 'local', project: developerListSummary
    }));

  register('devhub_create_developer', 'Onboard application developer',
    'Submit Developer Hub onboarding for an application developer using the admin API-access key. Approval is a separate devhub_approve_developer operation. Requires confirmation CREATE DEVELOPER <user_id>.',
    {
      user_id: developerId,
      first_name: z.string().min(1).max(255),
      last_name: z.string().min(1).max(255),
      email: z.string().email().max(255),
      country: z.string().max(255).default(''),
      reason: z.string().min(1).max(2048),
      confirmation
    }, CREATE_ANNOTATIONS,
    async ({ user_id, first_name, last_name, email, country, reason, confirmation }) => {
      requireConfirmation(confirmation, `CREATE DEVELOPER ${user_id}`);
      await client.request('POST', '/api/1.0/registrations', {
        json: {
          userId: user_id, firstName: first_name, lastName: last_name, emailId: email, country,
          rolesAccess: [{ requestReason: reason, role: 'API_ApplicationDeveloper' }]
        },
        expect: [201]
      });
      return { created: true, user_id, role: 'API_ApplicationDeveloper', approval_required: true };
    });

  register('devhub_approve_developer', 'Approve application developer',
    'Approve an onboarded Developer Hub application developer using the admin API-access key. Requires confirmation APPROVE DEVELOPER <user_id>.',
    { user_id: developerId, reason: z.string().min(1).max(2048), confirmation }, OVERWRITE_ANNOTATIONS,
    async ({ user_id, reason, confirmation }) => {
      requireConfirmation(confirmation, `APPROVE DEVELOPER ${user_id}`);
      await client.request('PUT', `/api/1.0/registrations/${encodeURIComponent(user_id)}`, {
        json: { rolesAccess: [{ status: 'registered', role: 'API_ApplicationDeveloper', responseReason: reason }] },
        expect: [200, 204]
      });
      return { approved: true, user_id, role: 'API_ApplicationDeveloper' };
    });

  register('devhub_create_application', 'Create subscribed consumer application',
    'Create a Developer Hub application on behalf of a registered developer with product subscriptions. SAP provisions the consumer key; key/secret values are redacted from output. External governance, if configured, may leave subscriptions pending. Requires confirmation CREATE CONSUMER APPLICATION <application_id>.',
    {
      application_id: applicationId,
      developer_id: developerId,
      title: z.string().min(1).max(255),
      description: z.string().max(2048).default(''),
      callback_url: z.string().url().max(2048).refine(value => {
        const url = new URL(value);
        return url.protocol === 'https:' && !url.username && !url.password;
      }, 'callback URL must use HTTPS without embedded credentials').optional(),
      products: z.array(productName).min(1).max(50).refine(values => new Set(values).size === values.length, 'products must be unique'),
      confirmation
    }, CREATE_ANNOTATIONS,
    async ({ application_id, developer_id, title, description, callback_url, products, confirmation }) => {
      requireConfirmation(confirmation, `CREATE CONSUMER APPLICATION ${application_id}`);
      const found = list(await request('GET', '/APIMgmt.Applications', {
        query: { $filter: `id eq '${application_id}'`, $top: 1 }
      }));
      if (found.some(app => app.id === application_id)) throw new IntegrationError(`Developer Hub application ${application_id} already exists; read it instead of creating it again`);
      for (const product of products) {
        const { status } = await request('GET', `/APIMgmt.APIProducts(${key(product)})`, { expect: [200, 404], withStatus: true });
        if (status === 404) throw new IntegrationError(`Developer Hub product ${product} is not available; publish it before creating the application`);
      }
      const created = await request('POST', '/APIMgmt.Applications', {
        json: {
          id: application_id, version: '1', title, description, callbackurl: callback_url ?? null, developer_id,
          ToSubscriptions: products.map(product => ({
            id: EMPTY_ID, ToAPIProduct: [{ __metadata: { uri: `APIMgmt.APIProducts('${product}')` } }]
          }))
        },
        expect: [200, 201]
      });
      return {
        created: true, application_id, application: applicationSummary(created),
        note: 'Read the application to check subscription approval and key availability. Do not repeat creation after a successful write.'
      };
    });

  register('devhub_subscribe_application', 'Subscribe application to a product',
    'Create a product subscription for an existing subscription-based Developer Hub application. Does not bypass external governance or return key/secret values. Requires confirmation SUBSCRIBE APPLICATION <application_id> TO <product>.',
    { application_id: applicationId, product: productName, confirmation }, CREATE_ANNOTATIONS,
    async ({ application_id, product, confirmation }) => {
      requireConfirmation(confirmation, `SUBSCRIBE APPLICATION ${application_id} TO ${product}`);
      const application = await getApplication(application_id);
      const subscriptions = list(application.ToSubscriptions);
      if (subscriptions.some(subscription => subscription.product_id === product)) {
        throw new IntegrationError(`Application ${application_id} already has a subscription for ${product}; read its status instead of creating a duplicate`);
      }
      if (!subscriptions.length && list(application.ToAPIProductsDetails).length) {
        throw new IntegrationError('This application uses legacy product links; create a subscription-based application instead of mixing subscription models');
      }
      const created = await request('POST', '/APIMgmt.Subscriptions', {
        json: {
          id: EMPTY_ID,
          ToAPIProduct: [{ __metadata: { uri: `APIMgmt.APIProducts('${product}')` } }],
          ToApplication: [{ __metadata: { uri: `APIMgmt.Applications('${application_id}')` } }]
        },
        expect: [200, 201]
      });
      return { created: true, application_id, product, subscription: redactPrivateValues(redactSecrets(entity(created)), [application.app_key, application.app_secret]) };
    });

  register('devhub_list_applications', 'List consumer applications',
    'List Developer Hub application metadata. Consumer keys and secrets are not returned; use devhub_get_application for subscription details.',
    { top: top(), cursor: cursorSchema }, READ_ONLY_ANNOTATIONS,
    async args => collections.page({
      ...args, path: '/APIMgmt.Applications', orderBy: 'id asc', identity: application => application.id,
      project: applicationListSummary
    }));

  register('devhub_get_application', 'Get consumer application',
    'Read one Developer Hub application with its product subscriptions. Consumer key/secret values are redacted; has_consumer_key reports key availability.',
    { application_id: applicationId }, READ_ONLY_ANNOTATIONS,
    async ({ application_id }) => applicationSummary(await getApplication(application_id)));

}

export function devhubToolNames() {
  const names = [];
  registerDevhubTools(name => names.push(name), null);
  return names;
}
