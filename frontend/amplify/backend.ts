//Bundles all backend resources together
//Lists resources to be deployed (sandbox)

import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource';
import { data } from './data/resource';

defineBackend
({
  auth,
  data,
});


/** more resources
 * @see https://docs.amplify.aws/react/build-a-backend/ to add storage, functions, and more
 */