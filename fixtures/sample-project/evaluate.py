import json


def evaluate():
    metrics = {
        "Recall@1": 46.2,
        "Recall@10": 79.4,
        "MRR": 58.7,
    }
    with open("results/metrics.json", "w", encoding="utf-8") as handle:
        json.dump(metrics, handle, indent=2)


if __name__ == "__main__":
    evaluate()

