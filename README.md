# FinEdgeAPI

FinEdgeAPI is a Node.js-based RESTful API designed to manage users, transactions, and budgets. It provides endpoints for user registration, transaction management, and income-expense summaries. The project follows the MVC architecture and includes middleware, async programming, and advanced Node.js concepts.

## Features

### Core Entities
1. **User**: Manages authentication and preferences.
2. **Transaction**: Tracks income/expense details, including type, category, amount, and date.
3. **Budget**: Helps set monthly goals and savings targets.

### Core Endpoints
| Method | Route               | Description                  |
|--------|---------------------|------------------------------|
| POST   | `/users`            | Register new user            |
| POST   | `/transactions`     | Add income/expense           |
| GET    | `/transactions`     | Fetch all transactions       |
| GET    | `/transactions/:id` | View single transaction      |
| PATCH  | `/transactions/:id` | Update transaction           |
| DELETE | `/transactions/:id` | Delete transaction           |
| GET    | `/summary`          | Fetch income-expense summary |

### Bonus Features
- **Analytics & Reporting**: Calculate totals, filter transactions, and show trends.
- **AI/Automation**: Suggest saving tips, auto-categorize expenses, and provide real-time updates.
- **Data Persistence**: Store data in JSON files or MongoDB.
- **Advanced Middleware**: Rate limiting, CORS, and in-memory caching.
