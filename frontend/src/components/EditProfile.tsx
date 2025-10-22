import { useState } from 'react';
import { updateUserProfile } from '../api';
import { updateUserAttributes, confirmUserAttribute } from 'aws-amplify/auth';

interface EditProfileProps {
  currentUser: {
    name: string;
    email: string;
  };
  onUpdateSuccess: (updatedUser: any) => void;
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

  if (isVerifyingEmail) {
    return (
      <div style={{
        background: '#f9f9f9',
        padding: '20px',
        borderRadius: '8px',
        marginTop: '20px',
        border: '1px solid #ddd'
      }}>
        <h3>Verify Email Change</h3>
        
        <p style={{ color: '#666', marginBottom: '15px' }}>
          We sent a verification code to your new email address ({pendingEmail}).
          Please enter the code below to confirm your email change.
        </p>
        
        <form onSubmit={handleVerifyEmail}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              Verification Code:
            </label>
            <input
              type="text"
              value={verificationCode}
              onChange={(e) => setVerificationCode(e.target.value)}
              placeholder="Enter 6-digit code"
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                border: '1px solid #ccc',
                borderRadius: '4px'
              }}
              required
            />
          </div>

          {error && (
            <p style={{ color: 'red', marginBottom: '10px', padding: '10px', backgroundColor: '#ffe6e6', borderRadius: '4px' }}>
              {error}
            </p>
          )}

          {successMessage && (
            <p style={{ color: 'green', marginBottom: '10px', padding: '10px', backgroundColor: '#e6ffe6', borderRadius: '4px' }}>
              {successMessage}
            </p>
          )}

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="submit"
              disabled={loading}
              style={{
                padding: '10px 20px',
                background: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: loading ? 'not-allowed' : 'pointer',
                opacity: loading ? 0.6 : 1
              }}
            >
              {loading ? 'Verifying...' : 'Verify Email'}
            </button>
            
            <button
              type="button"
              onClick={() => {
                setIsVerifyingEmail(false);
                setVerificationCode('');
                setPendingEmail(null);
                setError(null);
              }}
              disabled={loading}
              style={{
                padding: '10px 20px',
                background: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: loading ? 'not-allowed' : 'pointer'
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <div style={{
      background: '#f9f9f9',
      padding: '20px',
      borderRadius: '8px',
      marginTop: '20px',
      border: '1px solid #ddd'
    }}>
      <h3>Edit Profile</h3>
      
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
            Name:
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            style={{
              width: '100%',
              padding: '8px',
              fontSize: '14px',
              border: '1px solid #ccc',
              borderRadius: '4px'
            }}
            required
          />
        </div>

        <div style={{ marginBottom: '15px' }}>
          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
            Email:
          </label>
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={{
              width: '100%',
              padding: '8px',
              fontSize: '14px',
              border: '1px solid #ccc',
              borderRadius: '4px'
            }}
            required
          />
          <small style={{ color: '#666', marginTop: '5px', display: 'block' }}>
            Changing email will require verification via a code sent to your new email
          </small>
        </div>

        {error && (
          <p style={{ color: 'red', marginBottom: '10px', padding: '10px', backgroundColor: '#ffe6e6', borderRadius: '4px' }}>
            {error}
          </p>
        )}

        {successMessage && (
          <p style={{ color: 'green', marginBottom: '10px', padding: '10px', backgroundColor: '#e6ffe6', borderRadius: '4px' }}>
            {successMessage}
          </p>
        )}

        <div style={{ display: 'flex', gap: '10px' }}>
          <button
            type="submit"
            disabled={loading}
            style={{
              padding: '10px 20px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.6 : 1
            }}
          >
            {loading ? 'Saving...' : 'Save Changes'}
          </button>
          
          <button
            type="button"
            onClick={onCancel}
            disabled={loading}
            style={{
              padding: '10px 20px',
              background: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: loading ? 'not-allowed' : 'pointer'
            }}
          >
            Cancel
          </button>
        </div>
      </form>
    </div>
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