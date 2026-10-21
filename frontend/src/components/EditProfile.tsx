import { useState } from 'react';
import { updateUserProfile } from '../api/users';
import { updateUserAttributes, confirmUserAttribute } from 'aws-amplify/auth';
import type { UserProfile } from '../types/user';
import { Alert, Button, Card, FormField, Input } from './ui';
import styles from './EditProfile.module.css';

interface EditProfileProps {
  currentUser: {
    name: string;
    email: string;
  };
  onUpdateSuccess: (updatedUser: UserProfile) => void;
  onCancel: () => void;
}

export function EditProfile({ currentUser, onUpdateSuccess, onCancel }: EditProfileProps) {
  const [name, setName] = useState(currentUser.name);
  const [email, setEmail] = useState(currentUser.email);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Email verification state
  const [isVerifyingEmail, setIsVerifyingEmail] = useState(false);
  const [verificationCode, setVerificationCode] = useState('');
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const updates: { name?: string; email?: string } = {};

      if (name !== currentUser.name) {
        updates.name = name;
      }

      if (email !== currentUser.email) {
        updates.email = email;
      }

      if (Object.keys(updates).length === 0) {
        setError('No changes detected');
        setLoading(false);
        return;
      }

      // If email changed, update in Cognito (sends code to NEW email)
      if (updates.email) {
        console.log('Initiating email change, code will be sent to new email');

        await updateUserAttributes({
          userAttributes: {
            email: updates.email
          }
        });

        console.log('Email updated in Cognito, verification code sent to new email:', updates.email);

        setPendingEmail(updates.email);
        setIsVerifyingEmail(true);
        setSuccessMessage(`Verification code sent to ${updates.email}. Please check your inbox.`);
        setLoading(false);
        return;
      }

      // Only name update
      if (updates.name) {
        const result = await updateUserProfile(updates);
        setSuccessMessage('Name updated successfully!');
        setTimeout(() => {
          onUpdateSuccess(result.user);
        }, 2000);
      }

    } catch (err: any) {
      console.error('Error updating profile:', err);
      setError(err.message || 'Failed to update profile');
      setLoading(false);
    }
  };

  const handleVerifyEmail = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    if (!verificationCode.trim()) {
      setError('Please enter the verification code');
      setLoading(false);
      return;
    }

    if (!pendingEmail) {
      setError('No pending email found');
      setLoading(false);
      return;
    }

    try {
      // Confirm the email with verification code
      console.log('Confirming email with verification code');
      await confirmUserAttribute({
        userAttributeKey: 'email',
        confirmationCode: verificationCode
      });

      console.log('Email verified successfully with Cognito');

      // Update DynamoDB with new email
      const token = await getAuthToken();
      const verifyResponse = await fetch('/api/users/verify-email-change', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ email: pendingEmail })
      });

      if (!verifyResponse.ok) {
        const errorText = await verifyResponse.text();
        console.error('Backend error response:', errorText);
        throw new Error(`Backend error: ${errorText || 'Failed to verify email'}`);
      }

      const result = await verifyResponse.json();

      setSuccessMessage('Email successfully changed!');
      setIsVerifyingEmail(false);
      setVerificationCode('');
      setPendingEmail(null);
      setLoading(false);

      setTimeout(() => {
        onUpdateSuccess(result.user);
      }, 2000);

    } catch (err: any) {
      console.error('Error verifying email:', err);
      setError(err.message || 'Failed to verify email. Please check the code and try again.');
      setLoading(false);
    }
  };

  const messages = (
    <>
      {error && <Alert variant="danger">{error}</Alert>}
      {successMessage && <Alert variant="success">{successMessage}</Alert>}
    </>
  );

  if (isVerifyingEmail) {
    return (
      <Card title="Verify email change" headingLevel={2}>
        <p className={styles.intro}>
          We sent a verification code to your new email address ({pendingEmail}).
          Please enter the code below to confirm your email change.
        </p>

        <form onSubmit={handleVerifyEmail} className={styles.form}>
          <FormField label="Verification code" required>
            <Input
              type="text"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder="Enter 6-digit code"
              required
            />
          </FormField>

          {messages}

          <div className={styles.actions}>
            <Button type="submit" loading={loading}>
              {loading ? 'Verifying...' : 'Verify email'}
            </Button>

            <Button
              variant="secondary"
              onClick={() => {
                setIsVerifyingEmail(false);
                setVerificationCode('');
                setPendingEmail(null);
                setError(null);
              }}
              disabled={loading}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Card>
    );
  }

  return (
    <Card title="Edit profile" headingLevel={2}>
      <form onSubmit={handleSubmit} className={styles.form}>
        <FormField label="Name" required>
          <Input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </FormField>

        <FormField
          label="Email"
          required
          hint="Changing your email requires a verification code sent to the new address."
        >
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
        </FormField>

        {messages}

        <div className={styles.actions}>
          <Button type="submit" loading={loading}>
            {loading ? 'Saving...' : 'Save changes'}
          </Button>

          <Button variant="secondary" onClick={onCancel} disabled={loading}>
            Cancel
          </Button>
        </div>
      </form>
    </Card>
  );
}

async function getAuthToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No authentication token available');
  }
  return token;
}
