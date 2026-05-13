import torch
from transformers import AutoModel


def train():
    model = AutoModel.from_pretrained("distilbert-base-uncased")
    print("training latent router", model.config.hidden_size)


if __name__ == "__main__":
    train()

