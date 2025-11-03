import { useState, useEffect } from 'react';
import { getAllMilestones, createMilestone, deleteMilestone } from '../api/milestones';

interface Problem {
  milestoneId: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  createdAt: string;
  updatedAt: string;
}

interface ProblemsTabProps {
  userProfile: any;
}

export function ProblemsTab({ userProfile }: ProblemsTabProps) {
  // Default to 'user' role if missing or empty
  const userRole = userProfile?.role || 'user';
  const isAdmin = userRole === 'admin';
  console.log('User role:', userRole);
  console.log('Is admin:', isAdmin);

  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingProblem, setIsAddingProblem] = useState(false);
  const [newProblem, setNewProblem] = useState({
    title: '',
    description: '',
    difficulty: 'medium' as const
  });

  // Load problems from backend on component mount
  useEffect(() => {
    async function loadProblems() {
      try {
        setLoading(true);
        setError(null);
        console.log('Fetching problems from backend...');
        
        const result = await getAllMilestones();
        console.log('Problems loaded:', result);
        
        setProblems(result.milestones || []);
      } catch (err: any) {
        console.error('Failed to load problems:', err);
        setError('Failed to load problems from database');
      } finally {
        setLoading(false);
      }
    }
    
    loadProblems();
  }, []);

  const handleAddProblem = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newProblem.title.trim() || !newProblem.description.trim()) {
      setError('Title and description are required');
      return;
    }

    try {
      setError(null);
      console.log('Creating problem:', newProblem);
      
      const result = await createMilestone(newProblem);
      console.log('Problem created:', result);
      
      setProblems([...problems, result.milestone]);
      setNewProblem({ title: '', description: '', difficulty: 'medium' });
      setIsAddingProblem(false);
    } catch (err: any) {
      console.error('Failed to create problem:', err);
      setError('Failed to create problem. Please try again.');
    }
  };

  const handleDeleteProblem = async (milestoneId: string) => {
    if (!window.confirm('Are you sure you want to delete this problem?')) {
      return;
    }

    try {
      setError(null);
      console.log('Deleting problem:', milestoneId);
      
      await deleteMilestone(milestoneId);
      console.log('Problem deleted successfully');
      
      setProblems(problems.filter(p => p.milestoneId !== milestoneId));
    } catch (err: any) {
      console.error('Failed to delete problem:', err);
      setError('Failed to delete problem. Please try again.');
    }
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy':
        return '#28a745';
      case 'medium':
        return '#ffc107';
      case 'hard':
        return '#dc3545';
      default:
        return '#6c757d';
    }
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: 'rgba(255, 255, 255, 0.87)' }}>Loading problems...</p>
      </div>
    );
  }

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: 'rgba(255, 255, 255, 0.87)' }}>Problems</h2>
          <p style={{ color: 'rgba(255, 255, 255, 0.7)', margin: 0 }}>
            Total Problems: <strong>{problems.length}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => {
              setIsAddingProblem(!isAddingProblem);
              setError(null);
            }}
            style={{
              padding: '10px 20px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            {isAddingProblem ? 'Cancel' : 'Add Problem'}
          </button>
        )}
      </div>

      {error && (
        <div style={{
          background: '#dc3545',
          color: 'white',
          padding: '10px 15px',
          borderRadius: '4px',
          marginBottom: '20px'
        }}>
          {error}
        </div>
      )}

      {isAdmin && isAddingProblem && (
        <form onSubmit={handleAddProblem} style={{
          background: '#2d2d2d',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #4a4a4a'
        }}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: 'rgba(255, 255, 255, 0.87)'
            }}>
              Problem Title:
            </label>
            <input
              type="text"
              value={newProblem.title}
              onChange={(e) => setNewProblem({ ...newProblem, title: e.target.value })}
              placeholder="e.g., Two Sum"
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                border: '1px solid #4a4a4a',
                borderRadius: '4px',
                boxSizing: 'border-box',
                background: '#1a1a1a',
                color: 'rgba(255, 255, 255, 0.87)'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: 'rgba(255, 255, 255, 0.87)'
            }}>
              Description:
            </label>
            <textarea
              value={newProblem.description}
              onChange={(e) => setNewProblem({ ...newProblem, description: e.target.value })}
              placeholder="Describe the problem..."
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                border: '1px solid #4a4a4a',
                borderRadius: '4px',
                minHeight: '100px',
                boxSizing: 'border-box',
                background: '#1a1a1a',
                color: 'rgba(255, 255, 255, 0.87)'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: 'rgba(255, 255, 255, 0.87)'
            }}>
              Difficulty:
            </label>
            <select
              value={newProblem.difficulty}
              onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as any })}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                border: '1px solid #4a4a4a',
                borderRadius: '4px',
                background: '#1a1a1a',
                color: 'rgba(255, 255, 255, 0.87)'
              }}
            >
              <option value="easy">Easy</option>
              <option value="medium">Medium</option>
              <option value="hard">Hard</option>
            </select>
          </div>

          <button
            type="submit"
            style={{
              padding: '10px 20px',
              background: '#28a745',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            Add Problem
          </button>
        </form>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: '15px'
      }}>
        {problems.map((problem) => (
          <div
            key={problem.milestoneId}
            style={{
              background: '#333333',
              border: '2px solid #555555',
              borderRadius: '8px',
              padding: '15px'
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '10px' }}>
              <h3 style={{
                margin: 0,
                color: 'rgba(255, 255, 255, 0.87)'
              }}>
                {problem.title}
              </h3>
              <span style={{
                background: getDifficultyColor(problem.difficulty),
                color: 'white',
                padding: '4px 8px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
                textTransform: 'capitalize'
              }}>
                {problem.difficulty}
              </span>
            </div>

            <p style={{
              color: 'rgba(255, 255, 255, 0.7)',
              fontSize: '14px',
              marginBottom: '15px'
            }}>
              {problem.description}
            </p>

            <div style={{
              display: 'flex',
              gap: '10px',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <small style={{ color: 'rgba(255, 255, 255, 0.5)' }}>
                Added: {new Date(problem.createdAt).toLocaleDateString()}
              </small>

              {isAdmin && (
                <button
                  onClick={() => handleDeleteProblem(problem.milestoneId)}
                  style={{
                    padding: '8px 16px',
                    background: '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '12px',
                    fontWeight: 'bold'
                  }}
                >
                  Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>

      {problems.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          color: 'rgba(255, 255, 255, 0.5)'
        }}>
          <p>No problems yet. {isAdmin ? 'Add one to get started!' : 'Check back later!'}</p>
        </div>
      )}
    </div>
  );
}