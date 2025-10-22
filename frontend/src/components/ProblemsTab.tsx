import { useState } from 'react';

interface Problem {
  id: string;
  title: string;
  description: string;
  difficulty: 'easy' | 'medium' | 'hard';
  solved: boolean;
  createdAt: string;
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

  const [problems, setProblems] = useState<Problem[]>([
    {
      id: '1',
      title: 'Two Sum',
      description: 'Given an array of integers, find two numbers that add up to a specific target.',
      difficulty: 'easy',
      solved: true,
      createdAt: '2025-10-15T10:00:00Z'
    },
    {
      id: '2',
      title: 'Longest Substring Without Repeating Characters',
      description: 'Find the length of the longest substring without repeating characters.',
      difficulty: 'medium',
      solved: false,
      createdAt: '2025-10-20T14:30:00Z'
    },
    {
      id: '3',
      title: 'Median of Two Sorted Arrays',
      description: 'Find the median of two sorted arrays.',
      difficulty: 'hard',
      solved: false,
      createdAt: '2025-10-21T09:15:00Z'
    }
  ]);

  const [isAddingProblem, setIsAddingProblem] = useState(false);
  const [newProblem, setNewProblem] = useState({
    title: '',
    description: '',
    difficulty: 'medium' as const
  });

  const solvedCount = problems.filter(p => p.solved).length;

  const handleAddProblem = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProblem.title.trim() || !newProblem.description.trim()) {
      return;
    }

    const problem: Problem = {
      id: Date.now().toString(),
      title: newProblem.title,
      description: newProblem.description,
      difficulty: newProblem.difficulty,
      solved: false,
      createdAt: new Date().toISOString()
    };

    setProblems([...problems, problem]);
    setNewProblem({ title: '', description: '', difficulty: 'medium' });
    setIsAddingProblem(false);
  };

  const toggleProblemSolved = (id: string) => {
    setProblems(problems.map(p => 
      p.id === id ? { ...p, solved: !p.solved } : p
    ));
  };

  const deleteProblem = (id: string) => {
    setProblems(problems.filter(p => p.id !== id));
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

  return (
    <div>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Problems</h2>
          <p style={{ color: '#666', margin: 0 }}>
            Problems Solved: <strong>{solvedCount}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => setIsAddingProblem(!isAddingProblem)}
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

      {isAdmin && isAddingProblem && (
        <form onSubmit={handleAddProblem} style={{
          background: '#f9f9f9',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #ddd'
        }}>
          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
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
                border: '1px solid #ccc',
                borderRadius: '4px',
                boxSizing: 'border-box'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
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
                border: '1px solid #ccc',
                borderRadius: '4px',
                minHeight: '100px',
                boxSizing: 'border-box'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold' }}>
              Difficulty:
            </label>
            <select
              value={newProblem.difficulty}
              onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as any })}
              style={{
                width: '100%',
                padding: '8px',
                fontSize: '14px',
                border: '1px solid #ccc',
                borderRadius: '4px'
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
            key={problem.id}
            style={{
              background: problem.solved ? '#f0f0f0' : '#fff',
              border: `2px solid ${problem.solved ? '#ccc' : '#ddd'}`,
              borderRadius: '8px',
              padding: '15px',
              opacity: problem.solved ? 0.7 : 1
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '10px' }}>
              <h3 style={{
                margin: 0,
                textDecoration: problem.solved ? 'line-through' : 'none',
                color: problem.solved ? '#999' : '#333'
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
              color: '#666',
              fontSize: '14px',
              marginBottom: '15px',
              textDecoration: problem.solved ? 'line-through' : 'none'
            }}>
              {problem.description}
            </p>

            <div style={{
              display: 'flex',
              gap: '10px',
              justifyContent: 'space-between'
            }}>
              <button
                onClick={() => toggleProblemSolved(problem.id)}
                style={{
                  padding: '8px 16px',
                  background: problem.solved ? '#6c757d' : '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '4px',
                  cursor: 'pointer',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}
              >
                {problem.solved ? 'Mark Unsolved' : 'Mark Solved'}
              </button>

              {isAdmin && (
                <button
                  onClick={() => deleteProblem(problem.id)}
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

      {problems.length === 0 && (
        <div style={{
          textAlign: 'center',
          padding: '40px',
          color: '#999'
        }}>
          <p>No problems yet. Add one to get started!</p>
        </div>
      )}
    </div>
  );
}