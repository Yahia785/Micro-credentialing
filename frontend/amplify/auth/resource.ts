// Amplify configuration
import { defineAuth } from '@aws-amplify/backend';

//Defines the authentication features to be used by cognito

export const auth = defineAuth
({
  loginWith: 
  {
    email: true,
  },
});

/** More resources
 * Define and configure your auth resource
 * @see https://docs.amplify.aws/gen2/build-a-backend/auth
 */