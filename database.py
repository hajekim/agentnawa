import sqlite3
import os

DB_PATH = "likes.db"

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

def init_db():
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("DROP TABLE IF EXISTS likes")
    cursor.execute("""
        CREATE TABLE likes (
            user_email TEXT,
            app_id TEXT,
            agent_id TEXT,
            PRIMARY KEY (user_email, app_id, agent_id)
        )
    """)
    conn.commit()
    conn.close()

def add_like(user_email: str, app_id: str, agent_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    try:
        cursor.execute("INSERT INTO likes (user_email, app_id, agent_id) VALUES (?, ?, ?)", (user_email, app_id, agent_id))
        conn.commit()
        return True
    except sqlite3.IntegrityError:
        # Already liked
        return False
    finally:
        conn.close()

def get_likes_count(app_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT agent_id, COUNT(*) as count FROM likes WHERE app_id = ? GROUP BY agent_id", (app_id,))
    rows = cursor.fetchall()
    conn.close()
    return {row["agent_id"]: row["count"] for row in rows}

def has_user_liked(user_email: str, app_id: str, agent_id: str):
    conn = get_connection()
    cursor = conn.cursor()
    cursor.execute("SELECT 1 FROM likes WHERE user_email = ? AND app_id = ? AND agent_id = ?", (user_email, app_id, agent_id))
    result = cursor.fetchone()
    conn.close()
    return result is not None

if __name__ == "__main__":
    init_db()
    print("Database initialized.")
