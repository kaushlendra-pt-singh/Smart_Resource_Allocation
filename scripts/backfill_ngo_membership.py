"""
One-off repair for users promoted BEFORE the ngoId fix.

For every APPROVED NGO it makes the users collection agree with the NGO document:
  - owner (ngo.adminId)  -> user.ngoId = ngo._id (if the user owns nothing yet) + NGO_ADMIN membership
  - ngo.ngoAdmins        -> NGO_ADMIN membership in joinedNGOs
  - ngo.ngoWorkers       -> NGO_WORKER membership (unless already listed with another role)
  - global role recalculated from memberships (SUPER_ADMIN untouched)
and drops the cached Redis profile of every changed user.

Users only get the new token after their next /refresh-token or login.

Usage (from the repo root, with the allocation_svc venv):
  allocation_svc\\.venv\\Scripts\\python.exe -I scripts\\backfill_ngo_membership.py            # dry run
  allocation_svc\\.venv\\Scripts\\python.exe -I scripts\\backfill_ngo_membership.py --apply    # write
Optional: --db <name> to target another database than the one in auth_svc/.env.
"""
import argparse
import os
import re

import redis
from pymongo import MongoClient

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read_env(path):
    env = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip().strip('"')
    return env


def recalc_role(user):
    if user.get("role") == "SUPER_ADMIN":
        return "SUPER_ADMIN"
    roles = {j["roleInNGO"] for j in user.get("joinedNGOs", [])}
    for r in ("NGO_ADMIN", "NGO_WORKER", "VOLUNTEER"):
        if r in roles:
            return r
    return "RESIDENT"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry run)")
    ap.add_argument("--db", help="database name override")
    args = ap.parse_args()

    env = read_env(os.path.join(ROOT, "auth_svc", ".env"))
    uri = env["MONGODB_URI"]
    if args.db:
        uri = re.sub(r"/[^/?]+\?", f"/{args.db}?", uri, count=1)
    db = MongoClient(uri).get_database()
    print(f"Database: {db.name}  ({'APPLY' if args.apply else 'DRY RUN'})")

    users = db["users"]
    changed = {}  # user _id -> new doc fields

    def load(uid):
        if uid in changed:
            return changed[uid]
        u = users.find_one({"_id": uid}, {"ngoId": 1, "joinedNGOs": 1, "role": 1, "email": 1})
        if u:
            u.setdefault("joinedNGOs", [])
            u["_orig"] = (u.get("ngoId"), [dict(j) for j in u["joinedNGOs"]], u.get("role"))
            changed[uid] = u
        return u

    def ensure(u, ngo_id, role):
        for j in u["joinedNGOs"]:
            if j["ngoId"] == ngo_id:
                if role == "NGO_ADMIN" and j["roleInNGO"] != "NGO_ADMIN":
                    j["roleInNGO"] = "NGO_ADMIN"
                return
        u["joinedNGOs"].append({"ngoId": ngo_id, "roleInNGO": role})

    for ngo in db["ngos"].find({"verificationStatus": "APPROVED"}):
        nid = ngo["_id"]
        owner = load(ngo["adminId"])
        if owner:
            if not owner.get("ngoId"):
                owner["ngoId"] = nid
            ensure(owner, nid, "NGO_ADMIN")
        for uid in ngo.get("ngoAdmins", []):
            u = load(uid)
            if u:
                ensure(u, nid, "NGO_ADMIN")
        for uid in ngo.get("ngoWorkers", []):
            u = load(uid)
            if u:
                ensure(u, nid, "NGO_WORKER")

    r = None
    if args.apply:
        try:
            r = redis.Redis(host=env.get("REDIS_HOST", "localhost"), port=int(env.get("REDIS_PORT", 6379)))
            r.ping()
        except Exception as e:
            print(f"Redis not reachable ({e}); profile caches will expire on their own (24h).")
            r = None

    n = 0
    for uid, u in changed.items():
        u["role"] = recalc_role(u)
        if (u.get("ngoId"), u["joinedNGOs"], u.get("role")) == u["_orig"]:
            continue
        n += 1
        print(f"- {u.get('email')}: ngoId {u['_orig'][0]} -> {u.get('ngoId')}, role {u['_orig'][2]} -> {u['role']}, "
              f"memberships {len(u['_orig'][1])} -> {len(u['joinedNGOs'])}")
        if args.apply:
            users.update_one({"_id": uid}, {"$set": {"ngoId": u.get("ngoId"), "joinedNGOs": u["joinedNGOs"], "role": u["role"]}})
            if r:
                r.delete(f"user:{uid}:profile")
    print(f"{n} user(s) {'updated' if args.apply else 'would be updated'}.")


if __name__ == "__main__":
    main()
